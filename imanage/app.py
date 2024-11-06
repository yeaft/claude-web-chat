from flask import Flask, request, jsonify, render_template_string,send_file, send_from_directory, redirect, url_for
from werkzeug.utils import secure_filename
from datetime import datetime, timedelta
import base64
import uuid
from functools import wraps
import random
import string
import jwt  # 导入 PyJWT 库，用于处理 JWT 令牌
import os

app = Flask(__name__)

# Directory to store uploaded files
UPLOAD_FOLDER = 'uploads'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# JWT 配置
JWT_SECRET_KEY = '1qaz@WSX'  # 在生产环境中，请使用安全的密钥
JWT_ALGORITHM = 'HS256'

# OAuth2 配置
# 更新 clients 字典，移除过期的 'access_token' 和 'token_expiry' 字段
clients = {
    "client_localhost": {
        "client_secret": "localhost_secret",
        "redirect_uris": ["https://localhost/v1.0/admin/oauth/callback"],
        "authorized": False,
        "auth_code": "",
        "refresh_tokens": {}  # 存储刷新令牌
    },
    "client_df": {
        "client_secret": "df_secret",
        "redirect_uris": ["https://df-gcs.office.com/v1.0/admin/oauth/callback"],
        "authorized": False,
        "auth_code": "",
        "refresh_tokens": {}
    }
}

# 为 '11111111' 客户端生成一个永不过期的 JWT 访问令牌
always_valid_payload = {
    'client_id': '11111111',
    'token_type': 'access',
    'scope': 'read write'
    # 不包含 'exp' 声明，使其永不过期
}
always_valid_token = jwt.encode(always_valid_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

clients['11111111'] = {
    "client_secret": "always_valid",
    "redirect_uris": ["https://localhost/v1.0/admin/oauth/callback"],
    "authorized": True,
    "auth_code": "",
    "access_token": always_valid_token,
    "refresh_tokens": {}
}

# OAuth2 端点
@app.route('/authorize')
def authorize():
    client_id = request.args.get('client_id')
    redirect_uri = request.args.get('redirect_uri')
    state = request.args.get('state')
    response_mode = request.args.get('response_mode')  # 新增参数，用于控制响应模式

    if client_id in clients:
        if not redirect_uri or redirect_uri in clients[client_id]['redirect_uris']:
            # 模拟用户授权
            auth_code = str(uuid.uuid4())
            clients[client_id]['auth_code'] = auth_code

            if response_mode == 'direct':
                # 直接返回授权码，不进行重定向
                return jsonify({"code": auth_code, "state": state})
            elif redirect_uri:
                # 重定向回客户端，携带授权码
                return redirect(f"{redirect_uri}?code={auth_code}&state={state}")
            else:
                # 如果没有提供 redirect_uri，且未要求直接返回，则返回错误
                return jsonify({"error": "redirect_uri is required unless response_mode is 'direct'"}), 400
        else:
            return jsonify({"error": "Invalid redirect_uri"}), 400
    else:
        return jsonify({"error": "Invalid client_id"}), 400

@app.route('/callback')
def callback():
    # 模拟回调端点，直接返回授权码
    code = request.args.get('code')
    state = request.args.get('state')
    return jsonify({"code": code, "state": state})

@app.route('/token', methods=['POST'])
def token():
    grant_type = request.form.get('grant_type')
    client_id = request.form.get('client_id')
    client_secret = request.form.get('client_secret')

    if client_id not in clients or clients[client_id]['client_secret'] != client_secret:
        return jsonify({"error": "Invalid client credentials"}), 400

    if grant_type == 'authorization_code':
        auth_code = request.form.get('code')
        if clients[client_id]['auth_code'] == auth_code:
            if client_id == '11111111':
                return jsonify({
                    "access_token": always_valid_token,
                    "token_type": "Bearer",
                    "expires_in": 3600
                })
            # 生成访问令牌和刷新令牌（JWT）
            access_token_payload = {
                'client_id': client_id,
                'exp': datetime.utcnow() + timedelta(hours=1),
                'token_type': 'access',
                'scope': 'read write'  # 根据需要添加范围（scopes）
            }
            access_token = jwt.encode(access_token_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

            refresh_token_payload = {
                'client_id': client_id,
                'exp': datetime.utcnow() + timedelta(days=30),
                'token_type': 'refresh'
            }
            refresh_token = jwt.encode(refresh_token_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

            # 存储刷新令牌，并标记为有效
            clients[client_id]['refresh_tokens'][refresh_token] = {'valid': True}

            return jsonify({
                "access_token": access_token,
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": refresh_token
            })
        else:
            return jsonify({"error": "Invalid authorization code"}), 400

    elif grant_type == 'refresh_token':
        refresh_token = request.form.get('refresh_token')
        try:
            # 解码并验证刷新令牌
            refresh_token_payload = jwt.decode(refresh_token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
            client_id_from_token = refresh_token_payload['client_id']
            if client_id_from_token != client_id:
                return jsonify({"error": "Invalid client_id in refresh token"}), 400

            # 检查刷新令牌是否有效且未被使用
            if refresh_token in clients[client_id]['refresh_tokens'] and clients[client_id]['refresh_tokens'][refresh_token]['valid']:
                # 将已使用的刷新令牌标记为无效
                clients[client_id]['refresh_tokens'][refresh_token]['valid'] = False

                # 生成新的访问令牌和刷新令牌
                access_token_payload = {
                    'client_id': client_id,
                    'exp': datetime.utcnow() + timedelta(hours=12),
                    'token_type': 'access',
                    'scope': 'read write'
                }
                access_token = jwt.encode(access_token_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

                new_refresh_token_payload = {
                    'client_id': client_id,
                    'exp': datetime.utcnow() + timedelta(days=30),
                    'token_type': 'refresh'
                }
                new_refresh_token = jwt.encode(new_refresh_token_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

                # 存储新的刷新令牌
                clients[client_id]['refresh_tokens'][new_refresh_token] = {'valid': True}

                return jsonify({
                    "access_token": access_token,
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "refresh_token": new_refresh_token
                })
            else:
                return jsonify({"error": "Invalid or expired refresh token"}), 400
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Refresh token expired"}), 400
        except jwt.InvalidTokenError:
            return jsonify({"error": "Invalid refresh token"}), 400

    elif grant_type == 'client_credentials':
        if client_id == '11111111':
            return jsonify({
                "access_token": always_valid_token,
                "token_type": "Bearer",
                "expires_in": 3600
            })
        
        # 支持 client_credentials 授权类型
        access_token_payload = {
            'client_id': client_id,
            'exp': datetime.utcnow() + timedelta(hours=12),
            'token_type': 'access',
            'scope': 'read write'
        }
        access_token = jwt.encode(access_token_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

        return jsonify({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600
            # 不返回 refresh_token
        })

    else:
        return jsonify({"error": "Unsupported grant type"}), 400

# 用于令牌验证的装饰器
def token_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth_token = request.headers.get('x-auth-token', None)
        if not auth_token:
            auth_token = request.args.get('Authorization', None).replace('Bearer ', '')  # 从查询参数中获取令牌
        if auth_token:
            access_token = auth_token

            # 检查是否为 'always_valid' 令牌
            if access_token == clients['11111111']['access_token']:
                return f(*args, **kwargs)

            try:
                # 解码并验证访问令牌
                access_token_payload = jwt.decode(access_token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
                client_id_from_token = access_token_payload['client_id']
                # 可选地，您可以在此验证 client_id_from_token 是否有效
                return f(*args, **kwargs)
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "Access token expired"}), 401
            except jwt.InvalidTokenError:
                return jsonify({"error": "Invalid access token"}), 401
        return jsonify({"error": "Unauthorized"}), 401
    return wrapper

# Explanation for using 'x-auth-token' instead of 'Authorization':
"""
We're using 'x-auth-token' as a custom header for authentication instead of the standard 'Authorization' header. This approach can help avoid conflicts with intermediaries like proxies or browsers that might strip or alter the 'Authorization' header. Additionally, some security policies or CORS configurations might restrict the use of the 'Authorization' header. By using a custom header, we gain more control and reduce potential issues with header manipulation or restrictions.
"""

# Helper functions for random data generation
def random_string(length=8):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

def random_email():
    return f"{random_string(5)}@example.com"

def random_date(start, end):
    return start + timedelta(
        seconds=random.randint(0, int((end - start).total_seconds())),
    )

# Mock data store
customers = {}

def generate_data():
    now = datetime.utcnow()
    past = now - timedelta(days=365)
    customer_id = '123'
    customers[customer_id] = {
        'app': {
            'id': 'app_id_123'
        },
        'auth_status': 'authenticated',
        'capabilities': ['capability1', 'capability2'],
        'dms_version': 'v1.0',
        'user': {
            'customer_id': int(customer_id),
            'email': 'user@example.com',
            'id': 'user_123',
            'name': 'User Name',
            'ssid': 'ssid_123',
            'user_type': 'standard'
        },
        'versions': [
            {
                'name': 'version1',
                'url': 'http://example.com/version1',
                'version': '1.0.0'
            }
        ],
        'work': {
            'libraries': [],
            'preferred_library': 'Library1'
        },
        # 'documents', 'groups', 'users' are stored but will not be returned in the customer response
        'documents': [],
        'groups': [],
        'users': []
    }

    # Generate 8 libraries
    libraries = []
    for i in range(1, 9):
        lib = {
            'id': f'Library{i}',
            'type': 'worksite',
            'is_hidden': False
        }
        libraries.append(lib)
    customers[customer_id]['work']['libraries'] = libraries

    # Generate 600 users
    users = []
    for _ in range(600):
        user_id = random_string(8)
        user = {
            "allow_logon": random.choice([True, False]),
            "custom1": random_string(10),
            "custom2": random_string(10),
            "custom3": random_string(10),
            "database": random.choice(libraries)['id'],
            "doc_server": "DEFSERVER",
            "distinguished_name": f"cn={user_id},dc=example,dc=com",
            "edit_date": random_date(past, now).isoformat() + 'Z',
            "email": random_email(),
            "full_name": f"{random_string(5)} {random_string(7)}",
            "id": user_id,
            "is_external": random.choice([True, False]),
            "location": random.choice(["Chicago", "New York", "London"]),
            "preferred_library": random.choice(libraries)['id'],
            "ssid": str(uuid.uuid4()),
            "user_nos": random.randint(1, 10),
            "user_num": random.randint(10000, 99999)
        }
        users.append(user)
    customers[customer_id]['users'] = users

    # Generate 100 groups
    groups = []
    for i in range(100):
        group_id = random_string(6).upper()
        group_members = random.sample(users, random.randint(1, 5))
        group = {
            "access": random.randint(1, 3),
            "access_level": random.choice(["read", "read_write", "full_access"]),
            "id": group_id,
            "name": f"Group {group_id}",
            "sid": str(random.randint(1, 1000)),
            "type": "group",
            "is_external": False,
            "enabled": True,
            "members": [member['id'] for member in group_members]
        }
        groups.append(group)
    customers[customer_id]['groups'] = groups

    # Generate 1000 documents (200 emails, 800 files)
    documents = []
    for _ in range(1000):
        is_email = random.random() < 0.2  # 20% chance for email
        library = random.choice(libraries)
        doc_id = f"{library['id']}!{random.randint(10000, 99999)}.{random.randint(1, 10)}"
        create_date = random_date(past, now)
        edit_date = random_date(create_date, now)

        # Generate content for document or email
        if is_email:
            # For emails, generate email content
            email_subject = random_string(15)
            email_body = f"This is the body of the email {doc_id}"
            doc_content = f"Subject: {email_subject}\nFrom: {random_email()}\nTo: {random_email()}\n\n{email_body}"
        else:
            # For documents, generate document content
            doc_content = f"This is the content of document {doc_id}"

        doc = {
            "author": random.choice(users)['id'],
            "comment": random_string(20),
            "content_type": "email" if is_email else "document",
            "create_date": create_date.isoformat() + 'Z',
            "database": library['id'],
            "document_number": random.randint(10000, 99999),
            "edit_date": edit_date.isoformat() + 'Z',
            "extension": random.choice(["eml", "msg"]) if is_email else random.choice(["pdf", "docx", "txt"]),
            "file_create_date": create_date.isoformat() + 'Z',
            "file_edit_date": edit_date.isoformat() + 'Z',
            "id": doc_id,
            "iwl": f"iwl:dms=EXAMPLE&&lib={library['id']}&&num={random.randint(10000,99999)}&&ver={random.randint(1,10)}",
            "last_user": random.choice(users)['id'],
            "name": f"{random_string(10)} Document",
            "size": random.randint(1024, 1048576),
            "type": random.choice(["EMAIL", "MSG", "EML"]) if is_email else random.choice(["ACROBAT", "WORD", "TEXT"]),
            "version": random.randint(1, 10),
            "workspace_name": random_string(10),
            "wstype": "document",
            # Additional fields for emails
            "subject": email_subject if is_email else None,
            "cc": random_email() if is_email else None,
            "conversation_name": random_string(10) if is_email else None,
            "from": random_email() if is_email else None,
            "has_attachment": random.choice([True, False]) if is_email else None,
            "received_date": random_date(past, now).isoformat() + 'Z' if is_email else None,
            "sent_date": random_date(past, now).isoformat() + 'Z' if is_email else None,
            "to": random_email() if is_email else None,
            "co_authors": None if is_email else [random.choice(users)['id'] for _ in range(random.randint(0, 3))],
            # Add 'content' field
            "content": base64.b64encode(doc_content.encode()).decode('utf-8')
        }
        documents.append(doc)
    customers[customer_id]['documents'] = documents

    # Generate ACLs for each document
    for doc in documents:
        # Each document will have an ACL with random users and groups
        acl_entries = []
        num_acl_entries = random.randint(1, 5)
        for _ in range(num_acl_entries):
            acl_type = random.choice(['user', 'group'])
            if acl_type == 'user':
                user = random.choice(users)
                acl_entry = {
                    "access": random.randint(1, 3),
                    "access_level": random.choice(["read", "read_write", "full_access"]),
                    "id": user['id'],
                    "name": user['full_name'],
                    "sid": str(random.randint(1, 1000)),
                    "type": "user",
                    "is_external": user['is_external'],
                    "allow_logon": user['allow_logon']
                }
            else:
                group = random.choice(groups)
                acl_entry = {
                    "access": group['access'],
                    "access_level": group['access_level'],
                    "id": group['id'],
                    "name": group['name'],
                    "sid": group['sid'],
                    "type": "group",
                    "is_external": group['is_external'],
                    "enabled": group['enabled']
                }
            acl_entries.append(acl_entry)
        # Attach the ACL to the document
        doc['acl'] = {
            "data": acl_entries,
            "default_security": doc.get('default_security', 'private')
        }

# Call generate_data to initialize the data store
generate_data()

# API Implementations

@app.route('/api', methods=['GET'])
@token_required
def get_customer_id():
    customer_id = '123'
    customer_data = customers[customer_id].copy()
    # Exclude 'documents', 'users', and 'groups' from the response
    excluded_keys = ['documents', 'users', 'groups']
    for key in excluded_keys:
        customer_data.pop(key, None)
    response_data = {"data": customer_data}
    return jsonify(response_data)

# Existing global get documents API
@app.route('/work/api/v2/customers/<customerId>/documents', methods=['GET'])
@token_required
def get_global_documents(customerId):
    if customerId not in customers:
        customer_keys = list(customers.keys())
        return jsonify({"error": "Customer not found", "customerIds": customer_keys, "inputId": customerId}), 404

    documents = customers[customerId]['documents'].copy()

    # Handle query parameters
    offset = int(request.args.get('offset', 0))
    limit = int(request.args.get('limit', 500))
    limit = max(1, min(limit, 9999))
    libraries = request.args.get('libraries')
    edit_date_from = request.args.get('edit_date_from')

    # Filter by libraries
    if libraries:
        library_list = [lib.strip().lower() for lib in libraries.split(',')]
        documents = [doc for doc in documents if doc['database'].lower() in library_list]

    # Filter by edit_date_from
    if edit_date_from:
        try:
            edit_date_from_dt = datetime.strptime(edit_date_from, '%Y-%m-%dT%H:%M:%SZ')
            documents = [doc for doc in documents if datetime.strptime(doc['edit_date'], '%Y-%m-%dT%H:%M:%S.%fZ') >= edit_date_from_dt]
        except ValueError:
            try:
                edit_date_from_dt = datetime.strptime(edit_date_from, '%Y-%m-%dT%H:%M:%SZ')
                documents = [doc for doc in documents if datetime.strptime(doc['edit_date'], '%Y-%m-%dT%H:%M:%SZ') >= edit_date_from_dt]
            except ValueError:
                return jsonify({"error": "Invalid edit_date_from format"}), 400

    # Only include fields defined in DocumentItem
    document_fields = [
        "author",
        "comment",
        "content_type",
        "create_date",
        "database",
        "document_number",
        "edit_date",
        "extension",
        "file_create_date",
        "file_edit_date",
        "id",
        "iwl",
        "last_user",
        "name",
        "size",
        "type",
        "version",
        "workspace_name",
        "wstype",
        "subject",
        "cc",
        "conversation_name",
        "from",
        "has_attachment",
        "received_date",
        "sent_date",
        "to",
        "co_authors"
    ]

    filtered_documents = []
    for doc in documents:
        filtered_doc = {key: doc[key] for key in document_fields if key in doc and doc[key] is not None}
        filtered_documents.append(filtered_doc)

    # Apply offset and limit
    total_count = len(filtered_documents)
    filtered_documents = filtered_documents[offset:offset+limit]

    response_data = {
        "data": {
            "results": filtered_documents
        },
        "total_count": total_count
    }
    return jsonify(response_data)

# New library-based get documents API
@app.route('/work/api/v2/customers/<customerId>/libraries/<libraryId>/documents', methods=['GET'])
@token_required
def get_library_documents(customerId, libraryId):
    if customerId not in customers:
        customer_keys = list(customers.keys())
        return jsonify({"error": "Customer not found", "customerIds": customer_keys, "inputId": customerId}), 404

    documents = customers[customerId]['documents'].copy()

    # Filter documents by libraryId
    documents = [doc for doc in documents if doc['database'] == libraryId]

    # Handle query parameters
    offset = int(request.args.get('offset', 0))
    limit = int(request.args.get('limit', 500))
    limit = max(1, min(limit, 9999))
    edit_date_from = request.args.get('edit_date_from')

    # Filter by edit_date_from
    if edit_date_from:
        try:
            edit_date_from_dt = datetime.strptime(edit_date_from, '%Y-%m-%dT%H:%M:%SZ')
            documents = [doc for doc in documents if datetime.strptime(doc['edit_date'], '%Y-%m-%dT%H:%M:%S.%fZ') >= edit_date_from_dt]
        except ValueError:
            try:
                edit_date_from_dt = datetime.strptime(edit_date_from, '%Y-%m-%dT%H:%M:%SZ')
                documents = [doc for doc in documents if datetime.strptime(doc['edit_date'], '%Y-%m-%dT%H:%M:%SZ') >= edit_date_from_dt]
            except ValueError:
                return jsonify({"error": "Invalid edit_date_from format"}), 400

    # Only include fields defined in DocumentItem
    document_fields = [
        "author",
        "comment",
        "content_type",
        "create_date",
        "database",
        "document_number",
        "edit_date",
        "extension",
        "file_create_date",
        "file_edit_date",
        "id",
        "iwl",
        "last_user",
        "name",
        "size",
        "type",
        "version",
        "workspace_name",
        "wstype",
        "subject",
        "cc",
        "conversation_name",
        "from",
        "has_attachment",
        "received_date",
        "sent_date",
        "to",
        "co_authors"
    ]

    filtered_documents = []
    for doc in documents:
        filtered_doc = {key: doc[key] for key in document_fields if key in doc and doc[key] is not None}
        filtered_documents.append(filtered_doc)

    # Apply offset and limit
    total_count = len(filtered_documents)
    filtered_documents = filtered_documents[offset:offset+limit]

    response_data = {
        "data": {
            "results": filtered_documents
        },
        "total_count": total_count
    }
    return jsonify(response_data)

@app.route('/work/api/v2/customers/<customerId>/libraries/<libraryId>/documents/<docId>/download', methods=['GET'])
@token_required
def download_document(customerId, libraryId, docId):
    if customerId not in customers:
        return jsonify({"error": "Customer not found"}), 404

    documents = customers[customerId]['documents']
    doc = next((d for d in documents if d['id'] == docId and d['database'] == libraryId), None)
    if not doc:
        return jsonify({"error": "Document not found"}), 404

    # Handle 'latest' parameter
    latest = request.args.get('latest', 'false').lower() == 'true'
    if latest:
        # For simplicity, assume the latest version is the one with the highest 'version' field
        versions = [d for d in documents if d['document_number'] == doc['document_number']]
        latest_version = max(versions, key=lambda x: x['version'])
        doc = latest_version

    # Decode the content
    content = base64.b64decode(doc.get('content', '').encode())

    # Create a response with the content
    response = make_response(content)
    response.headers.set('Content-Type', 'application/octet-stream')
    response.headers.set('Content-Disposition', f'attachment; filename="{doc["name"]}"')
    response.headers.set('Content-Length', len(content))
    response.headers.set('Document-Id', doc['id'])
    return response

@app.route('/work/api/v2/customers/<customerId>/libraries/<libraryId>/documents/<docId>/security', methods=['GET'])
@token_required
def get_document_acl(customerId, libraryId, docId):
    if customerId not in customers:
        return jsonify({"error": "Customer not found"}), 404

    documents = customers[customerId]['documents']
    doc = next((d for d in documents if d['id'] == docId and d['database'] == libraryId), None)
    if not doc:
        return jsonify({"error": "Document not found"}), 404

    # Return the ACL specific to the document
    acl_data = doc.get('acl', {"data": [], "default_security": doc.get('default_security', 'private')})

    # Filter ACL entries
    acl_entry_fields = [
        "access",
        "access_level",
        "id",
        "name",
        "sid",
        "type",
        "is_external",
        "allow_logon",
        "enabled"
    ]
    filtered_acl_entries = []
    for entry in acl_data.get('data', []):
        filtered_entry = {key: entry[key] for key in acl_entry_fields if key in entry and entry[key] is not None}
        filtered_acl_entries.append(filtered_entry)

    response_acl_data = {
        "data": filtered_acl_entries,
        "default_security": acl_data.get('default_security', 'private')
    }
    return jsonify(response_acl_data)

@app.route('/work/api/v2/customers/<customerId>/libraries', methods=['GET'])
@token_required
def get_libraries(customerId):
    if customerId not in customers:
        return jsonify({"error": "Customer not found"}), 404
    libraries = customers[customerId]['work']['libraries']

    # Only include fields defined in IManageLibrary
    library_fields = ["id", "type", "is_hidden"]
    filtered_libraries = [{key: lib[key] for key in library_fields if key in lib} for lib in libraries]

    response_data = {
        "data": filtered_libraries
    }
    return jsonify(response_data)

@app.route('/work/api/v2/customers/<customerId>/libraries/<libraryId>/groups', methods=['GET'])
@token_required
def get_groups(customerId, libraryId):
    if customerId not in customers:
        return jsonify({"error": "Customer not found"}), 404
    groups = customers[customerId]['groups'].copy()

    # Handle query parameters
    enabled_param = request.args.get('enabled')
    offset = int(request.args.get('offset', 0))
    limit = int(request.args.get('limit', 500))
    limit = max(1, min(limit, 9999))

    # Filter by enabled status
    if enabled_param is not None:
        enabled = enabled_param.lower() == 'true'
        groups = [g for g in groups if g['enabled'] == enabled]

    # Apply offset and limit
    total_count = len(groups)
    groups = groups[offset:offset+limit]

    # Only include fields defined in IManageGroup
    group_fields = [
        "access",
        "access_level",
        "id",
        "name",
        "sid",
        "type",
        "is_external",
        "enabled",
        "members"
    ]
    filtered_groups = [{key: group[key] for key in group_fields if key in group} for group in groups]

    response_data = {
        "data": filtered_groups,
        "total_count": total_count
    }
    return jsonify(response_data)

@app.route('/work/api/v2/customers/<customerId>/libraries/<libraryId>/groups/<groupId>/members', methods=['GET'])
@token_required
def get_group_members(customerId, libraryId, groupId):
    if customerId not in customers:
        return jsonify({"error": "Customer not found"}), 404
    groups = customers[customerId]['groups']
    group = next((g for g in groups if g['id'] == groupId), None)
    if not group:
        return jsonify({"error": "Group not found"}), 404

    users = customers[customerId]['users']

    # Get members of the group
    members = [user for user in users if user['id'] in group['members']]

    # Handle query parameters
    allow_logon_param = request.args.get('allow_logon')
    offset = int(request.args.get('offset', 0))
    limit = int(request.args.get('limit', 500))
    limit = max(1, min(limit, 9999))

    # Filter by allow_logon
    if allow_logon_param is not None:
        allow_logon = allow_logon_param.lower() == 'true'
        members = [m for m in members if m['allow_logon'] == allow_logon]

    # Apply offset and limit
    total_count = len(members)
    members = members[offset:offset+limit]

    # Only include fields defined in IManageUser
    user_fields = [
        "allow_logon",
        "custom1",
        "custom2",
        "custom3",
        "database",
        "doc_server",
        "distinguished_name",
        "edit_date",
        "email",
        "full_name",
        "id",
        "is_external",
        "location",
        "preferred_library",
        "ssid",
        "user_nos",
        "user_num"
    ]
    filtered_members = [{key: member[key] for key in user_fields if key in member} for member in members]

    response_data = {
        "data": filtered_members,
        "total_count": total_count
    }
    return jsonify(response_data)

# New endpoint for email preview
@app.route('/work/api/v2/customers/<customerId>/libraries/<libraryId>/email/<docId>/preview', methods=['GET'])
@token_required
def preview_email(customerId, libraryId, docId):
    if customerId not in customers:
        return jsonify({"error": "Customer not found"}), 404

    documents = customers[customerId]['documents']
    # Find the email document
    doc = next((d for d in documents if d['id'] == docId and d['database'] == libraryId and d['content_type'] == 'email'), None)
    if not doc:
        return jsonify({"error": "Email not found"}), 404

    # Simulate email preview
    # Depending on the environment, return MSG, EML, or HTML content
    # For simplicity, we'll return an HTML preview

    email_content = f"""
    <html>
    <body>
        <h1>{doc.get('subject', 'No Subject')}</h1>
        <p>From: {doc.get('from')}</p>
        <p>To: {doc.get('to')}</p>
        <p>CC: {doc.get('cc')}</p>
        <p>Sent Date: {doc.get('sent_date')}</p>
        <p>Received Date: {doc.get('received_date')}</p>
        <hr>
        <p>{doc.get('comment', 'No content')}</p>
    </body>
    </html>
    """

    response = make_response(email_content)
    response.headers.set('Content-Type', 'text/html')
    response.headers.set('Content-Length', len(email_content))
    return response

# New endpoint to download the script file
@app.route('/download-script', methods=['GET'])
def download_script():
    script_path = os.path.join(os.path.dirname(__file__), 'api_call.ps1')  # Path to the script file in the same directory

    if os.path.exists(script_path):
        # Serve the file as an attachment
        return send_file(script_path, as_attachment=True, download_name='api_call.ps1')
    else:
        return jsonify({"error": "File not found"}), 404

# API to copy content
@app.route('/copy', methods=['GET'])
def copy():
    global copied_content
    copied_content = request.args.get('t')
    if copied_content is not None:
        return jsonify({"message": "Content copied successfully"}), 200
    else:
        return jsonify({"error": "No content provided"}), 400

# API to paste content
@app.route('/paste', methods=['GET'])
def paste():
    if copied_content is not None:
        return jsonify({"content": copied_content}), 200
    else:
        return jsonify({"error": "No content available to paste"}), 404

# HTML template for the UI
HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>File Upload and Download</title>
</head>
<body>
  <h2>Upload Files</h2>
  <form action="/upload" method="post" enctype="multipart/form-data">
    <input type="file" name="files" multiple>
    <input type="submit" value="Upload">
  </form>

  <h2>Available Files for Download</h2>
  <ul>
    {% for filename in files %}
      <li>{{ filename }} - <a href="{{ url_for('download_file', filename=filename) }}">Download</a></li>
    {% endfor %}
  </ul>
</body>
</html>
"""

# Route to display the upload/download UI
@app.route('/file-manager')
def file_manager():
    # List all files in the upload folder
    files = os.listdir(app.config['UPLOAD_FOLDER'])
    return render_template_string(HTML_TEMPLATE, files=files)

# Route to handle file uploads
@app.route('/upload', methods=['POST'])
def upload_file():
    if 'files' not in request.files:
        return jsonify({"error": "No files part in the request"}), 400

    files = request.files.getlist('files')
    for file in files:
        if file.filename == '':
            continue
        # Secure the filename and save it
        filename = secure_filename(file.filename)
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
    
    return redirect(url_for('file_manager'))

# Route to download a specific file
@app.route('/download/<filename>', methods=['GET'])
def download_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename, as_attachment=True)

# Entry point
if __name__ == '__main__':
    # Run the Flask app
    app.run(debug=True, port=8888, host='0.0.0.0')
