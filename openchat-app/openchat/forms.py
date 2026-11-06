from __future__ import annotations

from flask_wtf import FlaskForm
from wtforms import FileField, PasswordField, StringField, SubmitField, TextAreaField, HiddenField
from wtforms.validators import DataRequired, EqualTo, Length, Optional, Regexp, ValidationError

from .censor import censor, contains_slur
from .models import Chat, User
from .text import CHAT_RE, NAME_RE

_strip = [lambda s: s.strip() if isinstance(s, str) else s]


def _no_slurs(form, field):
    text = field.data or ""
    if len(text) > 100:  # the pattern/length validators reject it anyway; the filter is quadratic on huge input
        return
    if contains_slur(text):
        raise ValidationError("Please choose a different name.")


class LoginForm(FlaskForm):
    username = StringField("Username", validators=[DataRequired(), Length(max=64)], filters=_strip)
    password = PasswordField("Password", validators=[DataRequired(), Length(max=128)])
    submit = SubmitField("Sign In")


class RegistrationForm(FlaskForm):
    username = StringField(
        "Username", filters=_strip,
        validators=[DataRequired(), Regexp(NAME_RE.pattern + r"\Z", message="3-24 characters: letters, digits, _ and -."),
                    _no_slurs],
    )
    password = PasswordField("Password", validators=[DataRequired(), Length(min=8, max=128, message="8-128 characters.")])
    password2 = PasswordField("Repeat Password", validators=[DataRequired(), EqualTo("password", "Passwords must match.")])
    submit = SubmitField("Register")

    def validate_username(self, field):
        if User.get_by_username(field.data) is not None:
            raise ValidationError("That username is taken.")


class NewChatForm(FlaskForm):
    name = StringField(
        "Name", filters=_strip,
        validators=[DataRequired(), Regexp(CHAT_RE.pattern + r"\Z", message="3-30 characters: letters, digits, _ and -."),
                    _no_slurs],
    )
    about = TextAreaField("Description", filters=_strip, validators=[DataRequired(), Length(max=1000)])
    submit = SubmitField("Create")

    def validate_name(self, field):
        if Chat.get_by_name(field.data) is not None:
            raise ValidationError("That chat name is already taken.")


class EditChatForm(FlaskForm):
    about = TextAreaField("Description", filters=_strip, validators=[DataRequired(), Length(max=1000)])
    submit = SubmitField("Save")


class NewPostForm(FlaskForm):
    title = StringField("Title", filters=_strip, validators=[DataRequired(), Length(max=300)])
    body = TextAreaField("Text", filters=_strip, validators=[Length(max=4000)])
    image = FileField("Image (optional; JPEG, PNG, GIF or WebP, 5 MB max)", validators=[Optional()])
    submit = SubmitField("Post")


class CommentForm(FlaskForm):
    body = TextAreaField("Comment", filters=_strip, validators=[DataRequired(), Length(max=4000)])
    parent_id = HiddenField()
    submit = SubmitField("Comment")


class EditProfileForm(FlaskForm):
    about_me = TextAreaField("About me", filters=_strip, validators=[Length(max=300)])
    submit = SubmitField("Save")


def clean(text: str) -> str:
    """Mask slurs in user-written text (done when it is written, like the rest of the site)."""
    return censor(text)
