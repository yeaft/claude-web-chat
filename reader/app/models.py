from werkzeug.security import generate_password_hash, check_password_hash
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
