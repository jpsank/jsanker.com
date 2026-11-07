"""gunicorn entry point:  SCRIPT_NAME=/projects/protop/api gunicorn wsgi:app"""
from protop import create_app

app = create_app()
