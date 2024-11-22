# app/models.py
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin
from bson.objectid import ObjectId
from . import mongo, login_manager

class User(UserMixin):
    def __init__(self, user_data):
        self.id = str(user_data['_id'])  # 确保ID为字符串
        self.email = user_data['email']
        self.password_hash = user_data['password_hash']
        self.reading_history = user_data.get('reading_history', {})  # 初始化阅读历史

    @staticmethod
    def get(user_id):
        try:
            oid = ObjectId(user_id)
        except:
            return None
        user_data = mongo.db.users.find_one({'_id': oid})
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
        result = mongo.db.users.insert_one({
            'email': email,
            'password_hash': password_hash,
            'reading_history': {}  # 初始化阅读历史
        })
        return User.get(str(result.inserted_id))

    def update_reading_history(self, book_name, chapter):
        # 更新阅读历史
        self.reading_history[book_name] = chapter
        mongo.db.users.update_one(
            {'_id': ObjectId(self.id)},
            {'$set': {'reading_history': self.reading_history}}
        )

# 用户加载回调
@login_manager.user_loader
def load_user(user_id):
    return User.get(user_id)
