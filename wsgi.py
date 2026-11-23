from werkzeug.serving import run_simple

from search_eval.app import create_app

# gunicorn3.12 runs `wsgi:application` on base-microimage.
application = create_app()


if __name__ == "__main__":
    run_simple("0.0.0.0", 8181, application, use_reloader=False, use_debugger=True, threaded=True)
