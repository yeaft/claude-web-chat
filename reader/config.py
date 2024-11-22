import os

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'your-secret-key'
    MONGODB_HOST = os.getenv("MONGODB_HOST", "localhost")
    MONGO_URI = f'mongodb://{MONGODB_HOST}:27017/dao'
