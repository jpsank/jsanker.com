from __future__ import annotations

from datetime import datetime, timezone

from flask_login import UserMixin
from sqlalchemy import case, func, select
from sqlalchemy.orm import column_property
from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db, login


def utcnow() -> datetime:
    """Naive UTC, the format every timestamp column uses."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(UserMixin, db.Model):
    __tablename__ = "user"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(24), nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    about_me = db.Column(db.String(300), nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    last_seen = db.Column(db.DateTime, nullable=False, default=utcnow)

    posts = db.relationship("Post", backref="author", lazy="dynamic", passive_deletes=True)
    comments = db.relationship("Comment", backref="author", lazy="dynamic", passive_deletes=True)
    chats = db.relationship("Chat", backref="creator", lazy="dynamic", passive_deletes=True)

    __table_args__ = (db.Index("ix_user_username_lower", func.lower(username), unique=True),)

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    @staticmethod
    def get_by_username(username: str) -> "User | None":
        return db.session.scalar(select(User).where(func.lower(User.username) == username.lower()))

    def subscribed_post_ids(self):
        return select(Sub.chat_id).where(Sub.user_id == self.id)


@login.user_loader
def load_user(user_id: str) -> User | None:
    try:
        return db.session.get(User, int(user_id))
    except (TypeError, ValueError):
        return None


class Chat(db.Model):
    __tablename__ = "chat"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(30), nullable=False)
    about = db.Column(db.String(1000), nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    creator_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="SET NULL"), nullable=True)

    posts = db.relationship("Post", backref="chat", lazy="dynamic", cascade="all, delete-orphan", passive_deletes=True)

    __table_args__ = (db.Index("ix_chat_name_lower", func.lower(name), unique=True),)

    @staticmethod
    def get_by_name(name: str) -> "Chat | None":
        return db.session.scalar(select(Chat).where(func.lower(Chat.name) == name.lower()))


class Sub(db.Model):
    """Association: a user subscribed to a chat."""

    __tablename__ = "sub"
    user_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey("chat.id", ondelete="CASCADE"), primary_key=True)
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)


class Post(db.Model):
    __tablename__ = "post"
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(300), nullable=False)
    body = db.Column(db.String(4000), nullable=False, default="")
    image = db.Column(db.String(64), nullable=True)  # stored file name in the uploads directory
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    chat_id = db.Column(db.Integer, db.ForeignKey("chat.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True)

    comments = db.relationship("Comment", backref="post", lazy="dynamic", cascade="all, delete-orphan",
                               passive_deletes=True)


class Comment(db.Model):
    __tablename__ = "comment"
    id = db.Column(db.Integer, primary_key=True)
    body = db.Column(db.String(4000), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    post_id = db.Column(db.Integer, db.ForeignKey("post.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey("comment.id", ondelete="CASCADE"), nullable=True, index=True)

    replies = db.relationship("Comment", backref=db.backref("parent", remote_side=[id]), order_by="Comment.created_at",
                              cascade="all, delete-orphan", passive_deletes=True)


class Vote(db.Model):
    __tablename__ = "vote"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    post_id = db.Column(db.Integer, db.ForeignKey("post.id", ondelete="CASCADE"), nullable=True, index=True)
    comment_id = db.Column(db.Integer, db.ForeignKey("comment.id", ondelete="CASCADE"), nullable=True, index=True)
    liked = db.Column(db.Boolean, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("user_id", "post_id", name="uq_vote_user_post"),
        db.UniqueConstraint("user_id", "comment_id", name="uq_vote_user_comment"),
        db.CheckConstraint("(post_id IS NULL) != (comment_id IS NULL)", name="ck_vote_one_target"),
    )


# ------------------------------------------------------------------ scores ---
# Computed in SQL so that "popular" and the leaderboard can ORDER BY them.

_vote_value = case((Vote.liked.is_(True), 1), else_=-1)

Post.score = column_property(
    select(func.coalesce(func.sum(_vote_value), 0)).where(Vote.post_id == Post.id).correlate_except(Vote)
    .scalar_subquery()
)
Comment.score = column_property(
    select(func.coalesce(func.sum(_vote_value), 0)).where(Vote.comment_id == Comment.id).correlate_except(Vote)
    .scalar_subquery()
)
User.score = column_property(
    select(func.coalesce(func.sum(_vote_value), 0))
    .select_from(Vote.__table__.join(Post.__table__, Vote.post_id == Post.id))
    .where(Post.author_id == User.id).correlate_except(Vote, Post)
    .scalar_subquery()
)
Chat.subscriber_count = column_property(
    select(func.count()).select_from(Sub.__table__).where(Sub.chat_id == Chat.id).correlate_except(Sub)
    .scalar_subquery()
)
