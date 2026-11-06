from __future__ import annotations

import re

from flask import (Blueprint, Response, abort, current_app, flash, redirect, render_template, request,
                   send_from_directory, url_for)
from flask_login import current_user, login_required
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from .. import images
from ..avatars import identicon_svg
from ..extensions import db
from ..forms import CommentForm, EditChatForm, EditProfileForm, NewChatForm, NewPostForm, clean
from ..models import Chat, Comment, Post, Sub, User, Vote, utcnow
from ..security import ip_key, limiter, safe_local_path
from ..text import NAME_RE, like_pattern

bp = Blueprint("main", __name__)

MAX_REPLY_DEPTH = 6
UPLOAD_RE = re.compile(r"[0-9a-f]{32}\.(?:jpg|png)\Z")


# ---------------------------------------------------------------- helpers ---

def _page() -> int:
    return min(max(request.args.get("page", 1, type=int) or 1, 1), 10_000)


def _paginate(stmt, per_page: int | None = None):
    return db.paginate(stmt, page=_page(), per_page=per_page or current_app.config["PER_PAGE"], error_out=False)


def _query_term() -> str:
    return request.args.get("q", "").strip()[:100]


def _limit(bucket: str, count: int, seconds: int) -> None:
    """Abort with 429 when the signed-in user is over a limit."""
    if not limiter.allow(f"{bucket}:{current_user.id}", count, seconds):
        abort(429)


def _back(fallback: str):
    return redirect(safe_local_path(request.form.get("next"), request.script_root) or fallback)


def _my_votes(post_ids=(), comment_ids=()) -> dict[tuple[str, int], bool]:
    """{('post'|'comment', id): liked} for the signed-in user, in two queries for a whole page."""
    if not current_user.is_authenticated:
        return {}
    out: dict[tuple[str, int], bool] = {}
    if post_ids:
        rows = db.session.execute(select(Vote.post_id, Vote.liked).where(
            Vote.user_id == current_user.id, Vote.post_id.in_(list(post_ids))))
        out.update({("post", pid): liked for pid, liked in rows})
    if comment_ids:
        rows = db.session.execute(select(Vote.comment_id, Vote.liked).where(
            Vote.user_id == current_user.id, Vote.comment_id.in_(list(comment_ids))))
        out.update({("comment", cid): liked for cid, liked in rows})
    return out


def _my_subs() -> set[int]:
    if not current_user.is_authenticated:
        return set()
    return set(db.session.scalars(select(Sub.chat_id).where(Sub.user_id == current_user.id)))


def _post_stmt():
    return select(Post).options(selectinload(Post.author), selectinload(Post.chat))


def _render_posts(template: str, stmt, **ctx):
    page = _paginate(stmt)
    return render_template(template, posts=page.items, page=page, votes=_my_votes([p.id for p in page.items]), **ctx)


@bp.before_app_request
def _touch_last_seen() -> None:
    if current_user.is_authenticated and (utcnow() - current_user.last_seen).total_seconds() > 300:
        current_user.last_seen = utcnow()
        db.session.commit()


@bp.app_template_global()
def page_url(n: int) -> str:
    args = {**request.view_args, **request.args.to_dict(), "page": n}
    return url_for(request.endpoint, **args)


# ------------------------------------------------------------ front pages ---

@bp.route("/")
def index():
    return _home()


def _home():
    page = db.paginate(_post_stmt().order_by(Post.score.desc(), Post.created_at.desc()), page=1, per_page=10,
                       error_out=False)
    return render_template("main/home.html", posts=page.items, page=page,
                           votes=_my_votes([p.id for p in page.items]))


@bp.route("/feed")
@login_required
def feed():
    stmt = _post_stmt().where(Post.chat_id.in_(current_user.subscribed_post_ids())).order_by(Post.created_at.desc())
    return _render_posts("main/feed.html", stmt, title="Your Feed")


@bp.route("/popular")
def popular():
    stmt = _post_stmt()
    q = _query_term()
    if q:
        pat = like_pattern(q)
        stmt = stmt.where(Post.title.ilike(pat, escape="\\") | Post.body.ilike(pat, escape="\\"))
    return _render_posts("main/popular.html", stmt.order_by(Post.score.desc(), Post.created_at.desc()),
                         title="Popular", q=q)


@bp.route("/chats")
def explore_chats():
    stmt = select(Chat)
    q = _query_term()
    if q:
        pat = like_pattern(q)
        stmt = stmt.where(Chat.name.ilike(pat, escape="\\") | Chat.about.ilike(pat, escape="\\"))
    page = _paginate(stmt.order_by(Chat.subscriber_count.desc(), Chat.name))
    return render_template("main/explore_chats.html", title="Chats", chats=page.items, page=page, q=q, subs=_my_subs())


@bp.route("/leaderboard")
def leaderboard():
    stmt = select(User)
    q = _query_term()
    if q:
        stmt = stmt.where(User.username.ilike(like_pattern(q), escape="\\"))
    page = _paginate(stmt.order_by(User.score.desc(), User.created_at))
    return render_template("main/leaderboard.html", title="Leaderboard", users=page.items, page=page, q=q)


# ------------------------------------------------------------------ chats ---

@bp.route("/chat/<name>")
def show_chat(name: str):
    chat = Chat.get_by_name(name) or abort(404)
    stmt = _post_stmt().where(Post.chat_id == chat.id).order_by(Post.created_at.desc())
    return _render_posts("main/chat.html", stmt, title=chat.name, chat=chat, subs=_my_subs())


@bp.route("/create_chat", methods=["GET", "POST"])
@login_required
def create_chat():
    form = NewChatForm()
    if form.validate_on_submit():
        _limit("chat-create", 5, 86400)
        chat = Chat(name=form.name.data, about=clean(form.about.data), creator_id=current_user.id)
        db.session.add(chat)
        db.session.flush()
        db.session.add(Sub(user_id=current_user.id, chat_id=chat.id))
        db.session.commit()
        flash("Your new chat is live!")
        return redirect(url_for("main.show_chat", name=chat.name))
    return render_template("main/create_chat.html", title="New Chat", form=form)


@bp.route("/chat/<name>/edit", methods=["GET", "POST"])
@login_required
def edit_chat(name: str):
    chat = Chat.get_by_name(name) or abort(404)
    if chat.creator_id != current_user.id:
        abort(403)
    form = EditChatForm()
    if form.validate_on_submit():
        chat.about = clean(form.about.data)
        db.session.commit()
        flash("Your changes have been saved.")
        return redirect(url_for("main.show_chat", name=chat.name))
    if request.method == "GET":
        form.about.data = chat.about
    return render_template("main/edit_chat.html", title=f"Edit chat/{chat.name}", chat=chat, form=form)


@bp.post("/chat/<name>/subscribe")
@login_required
def subscribe(name: str):
    chat = Chat.get_by_name(name) or abort(404)
    action = request.form.get("action")
    if action not in ("sub", "unsub"):
        abort(400)
    _limit("subscribe", 120, 3600)
    existing = db.session.get(Sub, (current_user.id, chat.id))
    if action == "sub" and existing is None:
        db.session.add(Sub(user_id=current_user.id, chat_id=chat.id))
    elif action == "unsub" and existing is not None:
        db.session.delete(existing)
    db.session.commit()
    return _back(url_for("main.show_chat", name=chat.name))


# ------------------------------------------------------------------ posts ---

@bp.route("/chat/<name>/post", methods=["GET", "POST"])
@login_required
def make_post(name: str):
    chat = Chat.get_by_name(name) or abort(404)
    form = NewPostForm()
    if form.validate_on_submit():
        _limit("post-hour", 10, 3600)
        _limit("post-day", 30, 86400)
        filename = None
        upload = request.files.get("image")
        if upload is not None and upload.filename:
            try:
                filename = images.save(upload.read(images.MAX_BYTES + 1), current_app.config["UPLOAD_DIR"])
            except images.ImageRejected as e:
                form.image.errors.append(str(e))
                return render_template("main/make_post.html", title="New Post", chat=chat, form=form), 422
        post = Post(title=clean(form.title.data), body=clean(form.body.data or ""), image=filename,
                    chat_id=chat.id, author_id=current_user.id)
        db.session.add(post)
        db.session.commit()
        flash("Your post is live!")
        return redirect(url_for("main.show_post", post_id=post.id))
    return render_template("main/make_post.html", title="New Post", chat=chat, form=form)


@bp.route("/post/<int:post_id>")
def show_post(post_id: int):
    post = db.get_or_404(Post, post_id)
    stmt = select(Comment).options(selectinload(Comment.author)).where(
        Comment.post_id == post.id, Comment.parent_id.is_(None)).order_by(Comment.created_at.desc())
    page = _paginate(stmt, current_app.config["PER_PAGE"])

    ids: list[int] = []

    def walk(comments):
        for c in comments:
            ids.append(c.id)
            walk(c.replies)

    walk(page.items)
    return render_template(
        "main/post.html", title=post.title, post=post, comments=page.items, page=page,
        selected=request.args.get("c", type=int), comment_form=CommentForm(),
        votes=_my_votes([post.id], ids), max_depth=MAX_REPLY_DEPTH,
    )


@bp.post("/post/<int:post_id>/comment")
@login_required
def add_comment(post_id: int):
    post = db.get_or_404(Post, post_id)
    form = CommentForm()
    fallback = url_for("main.show_post", post_id=post.id)
    if not form.validate_on_submit():
        flash("A comment must be 1 to 4000 characters.")
        return _back(fallback)
    parent = None
    if form.parent_id.data:
        try:
            parent = db.session.get(Comment, int(form.parent_id.data))
        except ValueError:
            parent = None
        if parent is None or parent.post_id != post.id:
            abort(400)
        depth, node = 1, parent
        while node.parent is not None:
            depth, node = depth + 1, node.parent
        while depth >= MAX_REPLY_DEPTH and parent.parent is not None:  # too deep: attach beside it instead
            parent, depth = parent.parent, depth - 1
    _limit("comment", 40, 3600)
    comment = Comment(body=clean(form.body.data), post_id=post.id, author_id=current_user.id,
                      parent_id=parent.id if parent else None)
    db.session.add(comment)
    db.session.commit()
    flash("Your comment is live!")
    target = safe_local_path(request.form.get("next"), request.script_root) or fallback
    return redirect(f"{target.split('#')[0]}#c{comment.id}")


@bp.post("/post/<int:post_id>/delete")
@login_required
def delete_post(post_id: int):
    post = db.get_or_404(Post, post_id)
    if post.author_id != current_user.id:
        abort(403)
    chat_name, image = post.chat.name, post.image
    db.session.delete(post)
    db.session.commit()
    if image and UPLOAD_RE.fullmatch(image):
        (current_app.config["UPLOAD_DIR"] / image).unlink(missing_ok=True)
    flash("You deleted the post.")
    return redirect(url_for("main.show_chat", name=chat_name))


# ------------------------------------------------------------------ votes ---

@bp.post("/vote/<kind>/<int:item_id>")
@login_required
def vote(kind: str, item_id: int):
    if kind not in ("post", "comment"):
        abort(404)
    direction = request.form.get("dir")
    if direction not in ("up", "down", "clear"):
        abort(400)
    item = db.session.get(Post if kind == "post" else Comment, item_id) or abort(404)
    _limit("vote", 300, 3600)
    target = Vote.post_id if kind == "post" else Vote.comment_id
    existing = db.session.scalar(select(Vote).where(Vote.user_id == current_user.id, target == item_id))
    if direction == "clear":
        if existing is not None:
            db.session.delete(existing)
    elif existing is not None:
        existing.liked = direction == "up"
    else:
        db.session.add(Vote(user_id=current_user.id, liked=direction == "up",
                            **({"post_id": item_id} if kind == "post" else {"comment_id": item_id})))
    db.session.commit()
    post_id = item.id if kind == "post" else item.post_id
    return _back(url_for("main.show_post", post_id=post_id))


# ------------------------------------------------------------------ users ---

@bp.route("/user/<username>")
def show_user(username: str):
    user = User.get_by_username(username) or abort(404)
    stmt = _post_stmt().where(Post.author_id == user.id).order_by(Post.created_at.desc())
    return _render_posts("main/user.html", stmt, title=f"u/{user.username}", user=user)


@bp.route("/edit_profile", methods=["GET", "POST"])
@login_required
def edit_profile():
    form = EditProfileForm()
    if form.validate_on_submit():
        _limit("profile", 30, 3600)
        current_user.about_me = clean(form.about_me.data or "")
        db.session.commit()
        flash("Your changes have been saved.")
        return redirect(url_for("main.show_user", username=current_user.username))
    if request.method == "GET":
        form.about_me.data = current_user.about_me
    return render_template("main/edit_profile.html", title="Edit Profile", form=form)


# ----------------------------------------------------------------- assets ---

@bp.route("/uploads/<name>")
def upload(name: str):
    if not UPLOAD_RE.fullmatch(name):
        abort(404)
    return send_from_directory(current_app.config["UPLOAD_DIR"], name, mimetype=images.OUTPUTS[name.rsplit(".", 1)[1]],
                               max_age=30 * 86400, conditional=True)


@bp.route("/avatar/<name>.svg")
def avatar(name: str):
    if not NAME_RE.fullmatch(name):
        abort(404)
    resp = Response(identicon_svg(name), mimetype="image/svg+xml")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp
