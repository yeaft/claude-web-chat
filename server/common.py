import ipaddress
from functools import wraps
from statistics import mean
from flask import request, Response, abort


# ==================== Constants ====================

CACHE_TICKS = {}
CACHE_TICKS_1MIN = {}
CACHE_DAILY_CCL_DATA = {}
CACHE_CP_RATE_DATA = {}
PAST_CCL_STABLE_DATA = {}
TEN_DAYS_SIZE = int(12 * 60 * 5.8 * 10)
TEN_DAYS_MINS_SIZE = int(60 * 5.8 * 10)
FIVE_DAYS_MINS_SIZE = int(60 * 5.8 * 5)
LAST_DAY_SIZE = int(12 * 60 * 5.8)
HALF_DAY_SIZE = int(12 * 60 * 3)
KP_TICKS = {}
DATA_TYPES = ['rb']
BLOCKED_PATTERNS = [
    "45.128.*.*",
    "141.98.*.*"
]
FIND_PEAK_START_INDEX = 0
EXTREME_COLS = ["ccl", "zxj", "cjlDiff"]
EXTREME_SET = {}
LOW_CJL_MINUTE_THRESHOLD = 3000
MIN_CJL_5SEC_THRESHOLD = 1500


# ==================== IP Blocking ====================

def is_ip_blocked(ip_addr):
    for pattern in BLOCKED_PATTERNS:
        if '*' in pattern:
            base_ip = pattern.replace('*', '0')
            try:
                network = ipaddress.ip_network(base_ip)
                if ipaddress.ip_address(ip_addr) in network:
                    return True
            except ValueError:
                continue
        else:
            try:
                if ipaddress.ip_address(ip_addr) in ipaddress.ip_network(pattern, strict=False):
                    return True
            except ValueError:
                continue
    return False


def block_ip():
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if is_ip_blocked(request.remote_addr):
                abort(403)
            return f(*args, **kwargs)
        return decorated_function
    return decorator


# ==================== Authentication ====================

def check_auth(username, password):
    return username == 'hermes' and password == '1qaz@WSX'


def authenticate():
    return Response(
        'Could not verify your access level for that URL.\n'
        'You have to login with proper credentials', 401,
        {'WWW-Authenticate': 'Basic realm="Login Required"'})


def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password):
            return authenticate()
        return f(*args, **kwargs)
    return decorated


# ==================== Tick Aggregation ====================

def aggregate_ticks_to_1min(ticks, data_type):
    """将5秒级别的ticks数据聚合为1分钟级别的数据。

    逻辑：按 time 字段末尾 "00.000" 分割为每分钟分组，
    每组计算 max/min zxj, avg ccl, sum cjl。
    """
    m_ticks = []
    start_index = 0
    for i in range(len(ticks)):
        if ticks[i]['time'][-6:] == "00.000":
            if i - start_index >= 10:
                zxjs = [x['zxj'] for x in ticks[start_index:i + 1]]
                ccls = [x['ccl'] for x in ticks[start_index:i + 1]]
                min_zxj = min(zxjs)
                avg_ccl = mean(ccls)
                max_zxj = max(zxjs)
                cjl = sum(x['cjlDiff'] for x in ticks[start_index:i + 1] if 'cjlDiff' in x)

                m_ticks.append({
                    "time": ticks[i]['time'][:-4],
                    "code": ticks[i]['code'],
                    "max_zxj": int(max_zxj) if data_type != "i" else round(max_zxj * 2) / 2,
                    "min_zxj": int(min_zxj) if data_type != "i" else round(min_zxj * 2) / 2,
                    "ccl": int(avg_ccl),
                    "cjl": int(cjl),
                })

            start_index = i + 1
    return m_ticks
