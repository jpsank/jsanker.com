"""gunicorn entry point:  SCRIPT_NAME=/openchat gunicorn wsgi:app"""
from openchat import create_app

app = create_app()
