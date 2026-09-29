import os

ROOTDIR = os.path.dirname(os.path.realpath(__file__))
# shared with the Netlify function (frontend/functions/api)
DATADIR = os.path.join(ROOTDIR, '..', 'frontend', 'functions', 'api', 'data')
