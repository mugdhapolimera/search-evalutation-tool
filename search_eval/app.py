import os

from adsmutils import ADSFlask
from flask import send_from_directory

from .adapters import adapters_from_config
from .api import bp as api_bp

# config.py lives at the repository root, as in other ADS services. Passing it
# explicitly keeps discovery independent of where the app is imported from.
PROJ_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The React frontend is built into this folder (frontend/vite.config.ts), so one
# process serves both the API and the page.
FRONTEND_DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend_dist")


def create_app(adapters=None, **config):
    """Build the application.

    `config` overrides config.py and the environment, for tests. `adapters`
    replaces the configured environments, so tests never touch the network.
    """
    app = ADSFlask(
        __name__,
        proj_home=PROJ_HOME,
        local_config=config or None,
        static_folder=None,
    )
    app.url_map.strict_slashes = False
    app.extensions["search_adapters"] = adapters or adapters_from_config(
        app.config, http=app.client
    )
    app.register_blueprint(api_bp)

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def frontend(path):
        """Serve the built frontend; any unknown path is a client-side route."""
        if path.startswith("api/"):
            return {"error": "No such API endpoint."}, 404
        if path and os.path.isfile(os.path.join(FRONTEND_DIST, path)):
            return send_from_directory(FRONTEND_DIST, path)
        if not os.path.isfile(os.path.join(FRONTEND_DIST, "index.html")):
            return (
                "The frontend isn't built. Run `npm run build` in frontend/, or use "
                "`npm run dev` there and open http://localhost:5173.",
                503,
            )
        return send_from_directory(FRONTEND_DIST, "index.html")

    return app
