"""College Journal - JSON API only.

Run:  python app.py        (listens on http://127.0.0.1:5000)
The frontend is a separate set of static files (see ../frontend).

Auth: login returns a signed token. The frontend sends it back as
    Authorization: Bearer <token>
(No cookies, so it works when the HTML is opened straight from disk.)
"""
import atexit
import os
from functools import wraps
from urllib.parse import urlparse

import bcrypt
import psycopg2
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request
from flask_cors import CORS
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from psycopg2 import pool
from psycopg2.errors import UniqueViolation
from psycopg2.extras import RealDictCursor

load_dotenv()

app = Flask(__name__)

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY is not set")
app.secret_key = SECRET_KEY

# Which sites may call this API. "*" is fine here because we don't use cookies.
# Example to lock it down: CORS_ORIGINS="http://localhost:8000,http://127.0.0.1:8000"
origins = os.getenv("CORS_ORIGINS", "*")
CORS(app, origins=[o.strip() for o in origins.split(",")] if origins != "*" else "*")

TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7 days
serializer = URLSafeTimedSerializer(SECRET_KEY, salt="auth-token")

# Used so login takes the same time whether or not the email exists
DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt())

db_url = os.getenv("DATABASE_URL")
if not db_url:
    raise RuntimeError("DATABASE_URL is not set")

parsed_url = urlparse(db_url)
connection_para = {
    "user": parsed_url.username,
    "password": parsed_url.password,
    "host": parsed_url.hostname,
    "port": parsed_url.port or 5432,
    "database": parsed_url.path.lstrip("/"),
    "sslmode": "require",
}

db_pool = psycopg2.pool.ThreadedConnectionPool(minconn=1, maxconn=10, **connection_para)
atexit.register(db_pool.closeall)


# ---------- auth helpers ----------

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "login required"}), 401
        try:
            data = serializer.loads(header[7:], max_age=TOKEN_MAX_AGE)
        except (BadSignature, SignatureExpired):
            return jsonify({"error": "login required"}), 401
        g.user_id = data["user_id"]
        return f(*args, **kwargs)
    return wrapper


# ---------- db helpers ----------

def query_view(viewname, limit=50):
    conn = None
    try:
        conn = db_pool.getconn()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"SELECT * FROM {viewname} LIMIT %s;", (limit,))
            return cur.fetchall()
    except Exception:
        app.logger.exception("query_view failed")
        if conn:
            conn.rollback()
        return None
    finally:
        if conn:
            db_pool.putconn(conn)


def add_user(name, email, password, year):
    pass_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    conn = None
    try:
        conn = db_pool.getconn()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO users (user_name, user_email, pass_hash, year) "
                "VALUES (%s, %s, %s, %s) "
                "RETURNING user_id, user_name, user_email, year;",
                (name, email, pass_hash, year),
            )
            user = cur.fetchone()
        conn.commit()
        return user
    except Exception:
        if conn:
            conn.rollback()
        raise  # let the route decide the HTTP response
    finally:
        if conn:
            db_pool.putconn(conn)


def get_user_by_email(email):
    conn = None
    try:
        conn = db_pool.getconn()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT user_id, user_name, user_email, pass_hash, year "
                "FROM users WHERE user_email = %s;",
                (email,),
            )
            return cur.fetchone()
    except Exception:
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            db_pool.putconn(conn)


def view_response(viewname):
    rows = query_view(viewname)
    if rows is None:
        return jsonify({"error": "failed to query database"}), 500
    return jsonify(rows)


# ---------- routes ----------

@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/emails_from_clubs")
def emails_from_clubs():
    return view_response("emails_by_clubs")


@app.route("/api/view_clubs")
@login_required
def view_clubs():
    return view_response("v_clubs")


@app.route("/api/view_notices")
@login_required
def view_notices():
    return view_response("v_notices")


@app.route("/api/users", methods=["POST"])
def create_user():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    year = data.get("year")

    if not name or not email or not password:
        return jsonify({"error": "name, email and password are required"}), 400
    if len(name) > 50 or len(email) > 255:
        return jsonify({"error": "name or email too long"}), 400
    if len(password) < 8 or len(password.encode("utf-8")) > 72:
        return jsonify({"error": "password must be 8-72 bytes"}), 400
    if not isinstance(year, int) or isinstance(year, bool) or not (1 <= year <= 6):
        return jsonify({"error": "year must be an integer between 1 and 6"}), 400

    try:
        user = add_user(name, email, password, year)
    except UniqueViolation:
        return jsonify({"error": "email already registered"}), 409
    except Exception:
        app.logger.exception("add_user failed")
        return jsonify({"error": "failed to add user"}), 500

    return jsonify(user), 201


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not email or not password:
        return jsonify({"error": "email and password are required"}), 400

    password_bytes = password.encode("utf-8")
    if len(password_bytes) > 72:  # bcrypt limit, can't be a valid password
        return jsonify({"error": "invalid email or password"}), 401

    try:
        user = get_user_by_email(email)
    except Exception:
        app.logger.exception("login lookup failed")
        return jsonify({"error": "login failed"}), 500

    stored_hash = user["pass_hash"].encode("utf-8") if user else DUMMY_HASH
    password_ok = bcrypt.checkpw(password_bytes, stored_hash)

    if not user or not password_ok:
        return jsonify({"error": "invalid email or password"}), 401

    token = serializer.dumps({"user_id": user["user_id"]})
    return jsonify({
        "token": token,
        "user": {
            "user_id": user["user_id"],
            "user_name": user["user_name"],
            "user_email": user["user_email"],
            "year": user["year"],
        },
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
