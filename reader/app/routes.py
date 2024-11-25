from flask import Blueprint, render_template, redirect, url_for, request, flash, jsonify, Response
from flask_login import login_user, logout_user, current_user, login_required
from .models import User
from . import mongo
from bson.objectid import ObjectId

# Import OpenAI (for DeepSeek API)
import os
import openai

# Initialize OpenAI API key
openai.api_key = os.getenv("DEEPSEEK_API_KEY", "sk-e9c6ebc0a36041a1ac8b32dd2b6e14e7")
openai.base_url = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com")

# 定义蓝图
main_bp = Blueprint('main', __name__)
page_size = 10

# 登录视图
@main_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('main.index'))
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        user = User.find_by_email(email)
        if user and user.check_password(password):
            login_user(user)
            flash('登录成功!', 'success')
            return redirect(url_for('main.index'))
        else:
            flash('无效的用户名或密码.', 'danger')
    return render_template('login.html')

# 注销视图
@main_bp.route('/logout')
@login_required
def logout():
    logout_user()
    flash('您已登出.', 'info')
    return redirect(url_for('main.index'))

# 注册视图
@main_bp.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('main.index'))
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        if User.find_by_email(email):
            flash('邮箱地址已经注册', 'warning')
        else:
            user = User.create_user(email, password)
            login_user(user)
            flash('注册并登录成功!', 'success')
            return redirect(url_for('main.index'))
    return render_template('register.html')

# 主页面和搜索功能
@main_bp.route('/', methods=['GET', 'POST'])
def index():
    if request.method == 'POST':
        query = request.form.get('search')
        return redirect(url_for('main.search_results', query=query))
    return render_template('index.html')

@main_bp.route('/api/search', methods=['GET'])
def api_search():
    query = request.args.get('query', '').strip()
    page = int(request.args.get('page', 1))

    # 增加 chapter=1 的条件
    filters = {'chapter': 1}
    if query:
        filters['$and'] = [
            {'$or': [
                {'name': {'$regex': query, '$options': 'i'}},
                {'author': {'$regex': query, '$options': 'i'}},
                {'tags': {'$regex': query, '$options': 'i'}}
            ]}
        ]

    total_books = mongo.db.books.count_documents(filters)
    total_pages = (total_books + page_size - 1) // page_size

    # 确保页码在有效范围内
    if page < 1:
        page = 1
    elif page > total_pages:
        page = total_pages

    books_cursor = mongo.db.books.find(filters).skip((page - 1) * page_size).limit(page_size)
    books = []
    for book in books_cursor:
        books.append({
            'name': book['name'],
            'author': book.get('author', ''),
            'tags': book.get('tags', ''),
            'summary': book.get('summary', '')
        })

    return jsonify({
        'books': books,
        'total_pages': total_pages,
        'current_page': page
    })


# 自动完成 API
@main_bp.route('/api/search_suggestions')
def search_suggestions():
    query = request.args.get('query', '')
    suggestions = mongo.db.books.distinct('name', {'chapter': 1,'name': {'$regex': query, '$options': 'i'}})
    return jsonify(suggestions)

# 阅读页面
@main_bp.route('/book/<name>', defaults={'chapter': None}, methods=['GET', 'POST'])
@main_bp.route('/book/<name>/chapter/<int:chapter>', methods=['GET', 'POST'])
def book(name, chapter):
    # 查询章节内容
    document = mongo.db.books.find_one({'name': name, 'chapter': chapter}) if chapter else None
    if request.method == 'POST':
        # 用户输入章节号跳转
        input_chapter = request.form.get('chapter')
        try:
            input_chapter = int(input_chapter)
            max_chapter = mongo.db.books.count_documents({'name': name})
            if 1 <= input_chapter <= max_chapter:
                return redirect(url_for('main.book', name=name, chapter=input_chapter))
            else:
                flash(f'请输入有效的章节号（1-{max_chapter}）。', 'warning')
        except ValueError:
            flash('章节号必须是数字。', 'danger')
    
    if not chapter:
        # 如果章节未指定，获取用户的最后阅读章节
        if current_user.is_authenticated and name in current_user.reading_history:
            chapter = current_user.reading_history[name]
            document = mongo.db.books.find_one({'name': name, 'chapter': chapter})
            if not document:
                chapter = 1
                document = mongo.db.books.find_one({'name': name, 'chapter': chapter})
        else:
            chapter = 1
            document = mongo.db.books.find_one({'name': name, 'chapter': chapter})
    
    if not document:
        return "Chapter not found.", 404
    
    # 获取章节总数
    total_chapters = mongo.db.books.count_documents({'name': name})
    
    # 更新用户的最后阅读位置
    if current_user.is_authenticated:
        current_user.update_reading_history(name, chapter)
    
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

@main_bp.route('/api/books', methods=['GET'])
def api_books():
    query = request.args.get('query', '').strip()
    page = int(request.args.get('page', 1))

    # 增加 chapter=1 的条件
    filters = {'chapter': 1}
    if query:
        filters['$and'] = [
            {'$or': [
                {'name': {'$regex': query, '$options': 'i'}},
                {'author': {'$regex': query, '$options': 'i'}},
                {'tags': {'$regex': query, '$options': 'i'}}
            ]}
        ]

    total_books = mongo.db.books.count_documents(filters)
    total_pages = (total_books + page_size - 1) // page_size

    # 确保页码在有效范围内
    if page < 1:
        page = 1
    elif page > total_pages:
        page = total_pages

    books_cursor = mongo.db.books.find(filters).skip((page - 1) * page_size).limit(page_size)
    books = []
    for book in books_cursor:
        books.append({
            'name': book['name'],
            'author': book.get('author', ''),
            'tags': book.get('tags', ''),
            'summary': book.get('summary', '')
        })

    return jsonify({
        'books': books,
        'total_pages': total_pages,
        'current_page': page
    })

# New API route for chat
@main_bp.route('/api/chat', methods=['POST'])
def chat_api():
    data = request.get_json()
    messages = data.get('messages', [])
    stream = data.get('stream', False)

    if not messages:
        return jsonify({'error': 'No messages provided'}), 400

    # Limit to the last 10 pairs of messages (user and assistant)
    messages = messages[-20:]

    # Call OpenAI API (DeepSeek's API)
    try:
        if stream:
            # Stream response
            def generate():
                response = openai.chat.completions.create(
                    model="deepseek-chat",
                    messages=messages,
                    temperature=0.8,
                    stream=True
                )
                for chunk in response:
                    if chunk.choices:
                        choice = chunk.choices[0]
                        if choice.delta:
                            content = choice.delta.content
                            yield content

            return Response(generate(), content_type='text/event-stream')
        else:
            # Non-stream response
            response = openai.chat.completions.create(
                model="deepseek-chat",
                temperature=0.8,
                messages=messages,
                stream=False
            )
            return jsonify(response)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
