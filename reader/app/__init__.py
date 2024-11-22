# app/__init__.py
from flask import Flask
from config import Config
from flask_pymongo import PyMongo
from flask_login import LoginManager
import markdown  # 导入 markdown

mongo = PyMongo()
login_manager = LoginManager()
def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)
    app.secret_key = app.config['SECRET_KEY']  # 初始化密钥

     # 初始化扩展
    mongo.init_app(app)
     # 初始化Flask-Login
    login_manager.init_app(app)
    login_manager.login_view = 'main.login'  # 设置登录视图


    # 注册蓝图
    from .routes import main_bp
    app.register_blueprint(main_bp)

    # 注册 markdown 过滤器
    @app.template_filter('markdown')
    def markdown_filter(text):
        return markdown.markdown(text, extensions=['fenced_code', 'tables'])

    return app