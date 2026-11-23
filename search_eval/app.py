import os

from adsmutils import ADSFlask

from .adapters import adapters_from_config
from .views import bp

# config.py lives at the repository root, as in other ADS services. Passing it
# explicitly keeps discovery independent of where the app is imported from.
PROJ_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def create_app(adapters=None, **config):
    """Build the application.

    `config` overrides config.py and the environment, for tests. `adapters`
    replaces the configured environments, so tests never touch the network.
    """
    app = ADSFlask(
        __name__,
        proj_home=PROJ_HOME,
        local_config=config or None,
        static_folder="static",
        template_folder="templates",
    )
    app.url_map.strict_slashes = False
    app.extensions["search_adapters"] = adapters or adapters_from_config(
        app.config, http=app.client
    )
    app.register_blueprint(bp)
    return app
