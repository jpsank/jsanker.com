from __future__ import annotations

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required, login_user, logout_user

from ..extensions import db
from ..forms import LoginForm, RegistrationForm
from ..models import User
from ..security import ip_key, limiter, safe_local_path

bp = Blueprint("auth", __name__)

# Hash of a throwaway password, checked when the username doesn't exist so timing doesn't reveal which names exist.
_DUMMY = User()
_DUMMY.set_password("not-a-real-password")

LOGIN_FAILS, LOGIN_WINDOW = 10, 15 * 60


@bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    form = LoginForm()
    if form.validate_on_submit():
        name = form.username.data.lower()
        ip_k, user_k = ip_key("login"), f"login-user:{name}"
        if limiter.blocked(ip_k, LOGIN_FAILS, LOGIN_WINDOW) or limiter.blocked(user_k, LOGIN_FAILS, LOGIN_WINDOW):
            abort(429)
        user = User.get_by_username(form.username.data)
        ok = (user or _DUMMY).check_password(form.password.data) and user is not None
        if not ok:
            limiter.record(ip_k)
            limiter.record(user_k)
            flash("Invalid username or password.")
            return redirect(url_for("auth.login"))
        login_user(user)
        target = safe_local_path(request.args.get("next"), request.script_root)
        return redirect(target or url_for("main.index"))
    return render_template("auth/login.html", title="Sign In", form=form)


@bp.route("/logout", methods=["POST"])
@login_required
def logout():
    logout_user()
    flash("You are signed out.")
    return redirect(url_for("main.index"))


@bp.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    form = RegistrationForm()
    if form.validate_on_submit():
        if not limiter.allow(ip_key("register"), 5, 3600) or not limiter.allow("register:all", 100, 86400):
            abort(429)
        user = User(username=form.username.data)
        user.set_password(form.password.data)
        db.session.add(user)
        db.session.commit()
        flash("Welcome! You are registered. Sign in to start posting.")
        return redirect(url_for("auth.login"))
    return render_template("auth/register.html", title="Register", form=form)
