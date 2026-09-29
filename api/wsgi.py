import sys, logging
logging.basicConfig(stream=sys.stderr)
sys.path.insert(0, '/var/www/jsanker.com/api/')

from app import app as application
