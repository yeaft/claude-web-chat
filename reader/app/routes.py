# app/routes.py
from flask import Blueprint, render_template, redirect, url_for, request, flash, jsonify
from flask_login import login_user, logout_user, current_user, login_required
from .models import User
from . import mongo
from bson.objectid import ObjectId

# 定义蓝图
main_bp = Blueprint('main', __name__)

# 登录和注册视图
@main_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('main.index'))
    if request.method == 'POST':
        email = request.form['email']
        password = request.form['password']
        user = User.find_by_email(email)
        if user and user.check_password(password):
            login_user(user)
            return redirect(url_for('main.index'))
        else:
            flash('无效的用户名密码.')
    return render_template('login.html')

@main_bp.route('/logout')
def logout():
    logout_user()
    return redirect(url_for('main.index'))

@main_bp.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('main.index'))
    if request.method == 'POST':
        email = request.form['email']
        password = request.form['password']
        user = User.find_by_email(email)
        if user:
            flash('邮箱地址已经注册')
        else:
            user = User.create_user(email, password)
            login_user(user)
            return redirect(url_for('main.index'))
    return render_template('register.html')

# 主页面和搜索功能
@main_bp.route('/', methods=['GET', 'POST'])
def index():
    if current_user.is_authenticated and current_user.last_book:
        return redirect(url_for('main.book', name=current_user.last_book, chapter=current_user.last_chapter or 1))
    if request.method == 'POST':
        query = request.form['search']
        return redirect(url_for('main.search_results', query=query))
    return render_template('index.html')

@main_bp.route('/search')
def search_results():
    query = request.args.get('query', '')
    books = mongo.db.books.distinct('name', {'name': {'$regex': query}})
    return render_template('search.html', books=books, query=query)

# 自动完成 API
@main_bp.route('/api/search_suggestions')
def search_suggestions():
    query = request.args.get('query', '')
    suggestions = mongo.db.books.distinct('name', {'name': {'$regex': query}})
    return jsonify(suggestions)

# 阅读页面
@main_bp.route('/book/<name>', defaults={'chapter': 1})
@main_bp.route('/book/<name>/chapter/<int:chapter>')
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

    prev_chapter = chapter - 1 if chapter > 1 else None
    next_chapter = chapter + 1 if chapter < total_chapters else None
    return render_template(
        'book.html',
        document=document,
        total_chapters=total_chapters,
        is_mobile=is_mobile,
        prev_chapter=prev_chapter,
        next_chapter=next_chapter
    )

# API 接口
@main_bp.route('/api/search', methods=['GET'])
def api_search():
    query = request.args.get('query', '')
    books = mongo.db.books.distinct('name', {'name': {'$regex': query}})
    return jsonify({'books': books})

@main_bp.route('/api/book/<name>/chapter/<int:chapter>', methods=['GET'])
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
