import os

# 定义项目结构
project_structure = {
    'project': {
        'run.py': 'RUN_PY_CONTENT',
        'config.py': 'CONFIG_PY_CONTENT',
        'requirements.txt': 'REQUIREMENTS_TXT_CONTENT',
        'app': {
            '__init__.py': 'INIT_PY_CONTENT',
            'models.py': 'MODELS_PY_CONTENT',
            'routes.py': 'ROUTES_PY_CONTENT',
            'templates': {
                'base.html': 'BASE_HTML_CONTENT',
                'index.html': 'INDEX_HTML_CONTENT',
                'search.html': 'SEARCH_HTML_CONTENT',
                'book.html': 'BOOK_HTML_CONTENT',
                'login.html': 'LOGIN_HTML_CONTENT',
                'register.html': 'REGISTER_HTML_CONTENT',
            },
        },
        'static': {
            'css': {
                'style.css': 'STYLE_CSS_CONTENT',
            },
            'js': {
                # 如果有自定义的 JavaScript 文件，可以在此添加
            },
            'images': {
                # 如果有图片资源，可以在此添加
            }
        }
    }
}

# 各个文件的内容（按照最新的修改）

RUN_PY_CONTENT = '''from app import create_app

app = create_app()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5123)
'''

CONFIG_PY_CONTENT = '''import os

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'your-secret-key'
    MONGO_URI = 'mongodb://localhost:27017/your_database_name'
'''

REQUIREMENTS_TXT_CONTENT = '''flask
Flask-PyMongo
flask-login
werkzeug
flask-wtf
'''

INIT_PY_CONTENT = '''from flask import Flask
from config import Config
from flask_pymongo import PyMongo
from flask_login import LoginManager

mongo = PyMongo()
login_manager = LoginManager()
login_manager.login_view = 'login'

def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # 初始化扩展
    mongo.init_app(app)
    login_manager.init_app(app)

    # 注册路由
    from . import routes

    return app
'''

MODELS_PY_CONTENT = '''from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin
from . import mongo, login_manager
from bson.objectid import ObjectId

class User(UserMixin):
    def __init__(self, user_data):
        self.id = str(user_data['_id'])
        self.email = user_data['email']
        self.password_hash = user_data['password_hash']
        self.last_book = user_data.get('last_book')
        self.last_chapter = user_data.get('last_chapter')

    @staticmethod
    def get(user_id):
        user_data = mongo.db.users.find_one({'_id': ObjectId(user_id)})
        if user_data:
            return User(user_data)
        return None

    @staticmethod
    def find_by_email(email):
        user_data = mongo.db.users.find_one({'email': email})
        if user_data:
            return User(user_data)
        return None

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    @staticmethod
    def create_user(email, password):
        password_hash = generate_password_hash(password)
        user_id = mongo.db.users.insert_one({
            'email': email,
            'password_hash': password_hash
        }).inserted_id
        return User.get(user_id)

@login_manager.user_loader
def load_user(user_id):
    return User.get(user_id)
'''

ROUTES_PY_CONTENT = '''from flask import current_app as app, render_template, redirect, url_for, request, flash, jsonify
from flask_login import login_user, logout_user, current_user, login_required
from .models import User
from . import mongo
from bson.objectid import ObjectId

# 登录和注册视图
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        email = request.form['email']
        password = request.form['password']
        user = User.find_by_email(email)
        if user and user.check_password(password):
            login_user(user)
            return redirect(url_for('index'))
        else:
            flash('Invalid email or password.')
    return render_template('login.html')

@app.route('/logout')
def logout():
    logout_user()
    return redirect(url_for('index'))

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        email = request.form['email']
        password = request.form['password']
        user = User.find_by_email(email)
        if user:
            flash('Email already registered.')
        else:
            user = User.create_user(email, password)
            login_user(user)
            return redirect(url_for('index'))
    return render_template('register.html')

# 主页面和搜索功能
@app.route('/', methods=['GET', 'POST'])
def index():
    if current_user.is_authenticated and current_user.last_book:
        return redirect(url_for('book', name=current_user.last_book, chapter=current_user.last_chapter or 1))
    if request.method == 'POST':
        query = request.form['search']
        return redirect(url_for('search_results', query=query))
    return render_template('index.html')

@app.route('/search')
def search_results():
    query = request.args.get('query', '')
    books = mongo.db.books.distinct('name', {'name': {'$regex': query}})
    return render_template('search.html', books=books, query=query)

# 自动完成 API
@app.route('/api/search_suggestions')
def search_suggestions():
    query = request.args.get('query', '')
    suggestions = mongo.db.books.distinct('name', {'name': {'$regex': query}})
    return jsonify(suggestions)

# 阅读页面
@app.route('/book/<name>', defaults={'chapter': 1})
@app.route('/book/<name>/chapter/<int:chapter>')
def book(name, chapter):
    # 查询章节内容
    document = mongo.db.books.find_one({'name': name, 'chapter': chapter})
    if not document:
        return "Chapter not found.", 404
    # 获取章节总数
    total_chapters = mongo.db.books.count_documents({'name': name})
    # 更新用户的最后阅读位置
    if current_user.is_authenticated:
        mongo.db.users.update_one({'_id': ObjectId(current_user.id)}, {'$set': {'last_book': name, 'last_chapter': chapter}})
    # 检测是否为移动设备
    user_agent = request.headers.get('User-Agent')
    is_mobile = False
    if user_agent:
        is_mobile = any(mobile in user_agent.lower() for mobile in ['iphone', 'android'])
    return render_template('book.html', document=document, total_chapters=total_chapters, is_mobile=is_mobile)

# API 接口
@app.route('/api/search', methods=['GET'])
def api_search():
    query = request.args.get('query', '')
    books = mongo.db.books.distinct('name', {'name': {'$regex': query}})
    return jsonify({'books': books})

@app.route('/api/book/<name>/chapter/<int:chapter>', methods=['GET'])
def api_book_chapter(name, chapter):
    document = mongo.db.books.find_one({'name': name, 'chapter': chapter})
    if not document:
        return jsonify({'error': 'Chapter not found.'}), 404
    # 可以根据需要筛选需要返回的字段
    return jsonify({
        'name': document['name'],
        'author': document['author'],
        'chapter': document['chapter'],
        'chapter_title': document['chapter_title'],
        'original_text': document['original_text'],
        'plain_translation': document['plain_translation'],
        'allusion_explanation': document['allusion_explanation'],
        'profound_sentences': document['profound_sentences'],
        'summary': document['summary'],
        'chapter_count': document['chapter_count']
    })
'''

BASE_HTML_CONTENT = '''<!DOCTYPE html>
<html lang="en">
<head>
    <!-- Meta 标签 -->
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Bootstrap CSS -->
    <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.0/css/bootstrap.min.css">
    <!-- 自定义 CSS -->
    <link rel="stylesheet" href="{{ url_for('static', filename='css/style.css') }}">
    <!-- 引入字体 -->
    <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC&display=swap" rel="stylesheet">
    <title>{% block title %}Reading App{% endblock %}</title>
</head>
<body>
    <!-- 导航栏 -->
    <nav class="navbar navbar-expand-lg navbar-light bg-light">
        <a class="navbar-brand" href="{{ url_for('index') }}">Reading App</a>
        <!-- 登录/登出链接 -->
        <div class="ml-auto">
            {% if current_user.is_authenticated %}
            <a href="{{ url_for('logout') }}" class="btn btn-outline-secondary">Logout</a>
            {% else %}
            <a href="{{ url_for('login') }}" class="btn btn-outline-primary">Login</a>
            <a href="{{ url_for('register') }}" class="btn btn-primary">Register</a>
            {% endif %}
        </div>
    </nav>
    <!-- 主内容 -->
    {% block content %}{% endblock %}
    <!-- Bootstrap 和自定义的 JS 脚本 -->
    <script src="https://code.jquery.com/jquery-3.5.1.slim.min.js"></script>
    {% block scripts %}{% endblock %}
</body>
</html>
'''

INDEX_HTML_CONTENT = '''{% extends 'base.html' %}
{% block content %}
<div class="container">
    <h2>Search for Books</h2>
    <form method="post" action="{{ url_for('index') }}">
        <div class="form-group">
            <input type="text" name="search" id="search" class="form-control" placeholder="Enter book name" autocomplete="off">
        </div>
    </form>
    <ul id="suggestions" class="list-group"></ul>
</div>
{% endblock %}

{% block scripts %}
<script>
    // 实现自动完成功能
    const searchInput = document.getElementById('search');
    const suggestions = document.getElementById('suggestions');

    searchInput.addEventListener('input', function() {
        const query = this.value;
        if (query.length > 0) {
            fetch('/api/search_suggestions?query=' + query)
                .then(response => response.json())
                .then(data => {
                    suggestions.innerHTML = '';
                    data.forEach(item => {
                        const li = document.createElement('li');
                        li.classList.add('list-group-item');
                        li.textContent = item;
                        li.addEventListener('click', function() {
                            searchInput.value = this.textContent;
                            suggestions.innerHTML = '';
                        });
                        suggestions.appendChild(li);
                    });
                });
        } else {
            suggestions.innerHTML = '';
        }
    });
</script>
{% endblock %}
'''

SEARCH_HTML_CONTENT = '''{% extends 'base.html' %}
{% block content %}
<div class="container">
    <h2>Search Results for "{{ query }}"</h2>
    {% if books %}
    <ul class="list-group">
        {% for book in books %}
        <li class="list-group-item">
            <a href="{{ url_for('book', name=book) }}">{{ book }}</a>
        </li>
        {% endfor %}
    </ul>
    {% else %}
    <p>No books found.</p>
    {% endif %}
</div>
{% endblock %}
'''

BOOK_HTML_CONTENT = '''{% extends 'base.html' %}
{% block content %}
<div class="container-fluid">
    <div class="row">
        {% if not is_mobile %}
        <!-- 桌面布局 -->
        <div class="col-md-6" id="original-text">
            <h3>{{ document.chapter_title }}</h3>
            <p>{{ document.original_text | safe }}</p>
        </div>
        <div class="col-md-6" id="translated-text">
            <h3>翻译、引用和经典句子</h3>
            <h4>白话文翻译</h4>
            <p>{{ document.plain_translation | safe }}</p>
            <h4>典故解释</h4>
            <p>{{ document.allusion_explanation | safe }}</p>
            <h4>深刻句子汇总</h4>
            <p>{{ document.profound_sentences | safe }}</p>
        </div>
        {% else %}
        <!-- 移动设备布局 -->
        <div class="col-12">
            <h3>{{ document.chapter_title }}</h3>
            <h4>原文</h4>
            <p>{{ document.original_text | safe }}</p>
            <h4>白话文翻译</h4>
            <p>{{ document.plain_translation | safe }}</p>
            <h4>典故解释</h4>
            <p>{{ document.allusion_explanation | safe }}</p>
            <h4>深刻句子汇总</h4>
            <p>{{ document.profound_sentences | safe }}</p>
        </div>
        {% endif %}
    </div>
    <!-- 导航 -->
    <div class="row mt-4">
        <div class="col-12 text-center">
            {% if document.chapter > 1 %}
            <a href="{{ url_for('book', name=document.name, chapter=document.chapter - 1) }}" class="btn btn-primary">上一章</a>
            {% endif %}
            {% if document.chapter < total_chapters %}
            <a href="{{ url_for('book', name=document.name, chapter=document.chapter + 1) }}" class="btn btn-primary">下一章</a>
            {% endif %}
        </div>
    </div>
</div>
{% endblock %}

{% block scripts %}
<script>
    // 检测设备类型
    var is_mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    // 在模板中使用 is_mobile 变量
    var is_mobile_template = '{{ is_mobile }}';
    if (is_mobile_template !== String(is_mobile)) {
        location.reload();
    }

    // 同步滚动
    const originalText = document.getElementById('original-text');
    const translatedText = document.getElementById('translated-text');

    if (originalText && translatedText) {
        originalText.addEventListener('scroll', function() {
            translatedText.scrollTop = originalText.scrollTop;
        });

        translatedText.addEventListener('scroll', function() {
            originalText.scrollTop = translatedText.scrollTop;
        });
    }
</script>
{% endblock %}
'''

LOGIN_HTML_CONTENT = '''{% extends 'base.html' %}
{% block content %}
<div class="container">
    <h2>Login</h2>
    <form method="post">
        <div class="form-group">
            <label>Email:</label>
            <input type="email" name="email" class="form-control" required autofocus>
        </div>
        <div class="form-group">
            <label>Password:</label>
            <input type="password" name="password" class="form-control" required>
        </div>
        <button type="submit" class="btn btn-primary">Login</button>
    </form>
    <p>Don't have an account? <a href="{{ url_for('register') }}">Register here</a>.</p>
</div>
{% endblock %}
'''

REGISTER_HTML_CONTENT = '''{% extends 'base.html' %}
{% block content %}
<div class="container">
    <h2>Register</h2>
    <form method="post">
        <div class="form-group">
            <label>Email:</label>
            <input type="email" name="email" class="form-control" required autofocus>
        </div>
        <div class="form-group">
            <label>Password:</label>
            <input type="password" name="password" class="form-control" required>
        </div>
        <button type="submit" class="btn btn-primary">Register</button>
    </form>
    <p>Already have an account? <a href="{{ url_for('login') }}">Login here</a>.</p>
</div>
{% endblock %}
'''

STYLE_CSS_CONTENT = '''body {
    font-family: 'Noto Serif SC', serif;
    line-height: 1.6;
    background-color: #f8f9fa;
}

h3, h4 {
    margin-top: 20px;
}

#original-text, #translated-text {
    height: 80vh;
    overflow-y: auto;
    padding: 20px;
    background-color: #fff;
}

#original-text {
    border-right: 1px solid #dee2e6;
}

p {
    text-indent: 2em;
}

@media (max-width: 768px) {
    #original-text, #translated-text {
        height: auto;
        overflow-y: visible;
        padding: 10px;
    }
}
'''

def create_project(structure, root='.'):
    for name, content in structure.items():
        path = os.path.join(root, name)
        if isinstance(content, dict):
            os.makedirs(path, exist_ok=True)
            create_project(content, path)
        else:
            # 将占位符替换为实际的内容变量
            file_content = globals().get(content, '')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(file_content)
            print(f"Created file: {path}")

if __name__ == '__main__':
    create_project(project_structure)
    print("Project setup complete.")
