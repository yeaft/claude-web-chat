from flask import Flask, request, render_template,Response, abort
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
import ipaddress
from datetime import datetime, timedelta
import time, pytz
from functools import wraps
from statistics import mean
from flask_compress import Compress
from functools import wraps

app = Flask(__name__)
Compress(app)

CACHE_TICKS = {}
CACHE_TICKS_1MIN = {}
CACHE_DAILY_CCL_DATA = {}
CACHE_CP_RATE_DATA = {}
PAST_CCL_STABLE_DATA = {}
FIVE_DAYS_SIZE = int(12 * 60 * 5.8 * 5)
LAST_DAY_SIZE = int(12 * 60 * 5.8)
HALF_DAY_SIZE = int(12 * 60 * 3)
KP_TICKS = {}
DATA_TYPES= ['rb', 'i']
BLOCKED_PATTERNS = [
    "45.128.*.*",
    "141.98.*.*"
]

def block_ip():
    def decorator(f):
        @wraps(f)  # This preserves the original function's name and docstring
        def decorated_function(*args, **kwargs):
            if is_ip_blocked(request.remote_addr):
                abort(403)  # Forbidden
            return f(*args, **kwargs)
        return decorated_function
    return decorator

def is_ip_blocked(ip_addr):
    for pattern in BLOCKED_PATTERNS:
        if '*' in pattern:  # Simple wildcard matching
            base_ip = pattern.replace('*', '0')
            try:
                network = ipaddress.ip_network(base_ip)
                if ipaddress.ip_address(ip_addr) in network:
                    return True
            except ValueError:
                continue
        else:  # CIDR notation
            try:
                if ipaddress.ip_address(ip_addr) in ipaddress.ip_network(pattern, strict=False):
                    return True
            except ValueError:
                continue
    return False
    
def check_auth(username, password):
    """Check if a username / password combination is valid."""
    return username == 'hermes' and password == '1qaz@WSX'  # Replace with your credentials

def authenticate():
    """Sends a 401 response to request authentication."""
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

def initial_ticks():
    for data_type in DATA_TYPES:        
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(FIVE_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks
            
            m_ticks = []
            start_index = len(sorted_ticks) - LAST_DAY_SIZE
            for i in range(len(sorted_ticks) - LAST_DAY_SIZE, len(sorted_ticks)):
                if sorted_ticks[i]['time'][-6:] == "00.000":
                    if i - start_index > 10:
                        zxjs = [x['zxj'] for x in sorted_ticks[start_index:i+1]]
                        ccls = [x['ccl'] for x in sorted_ticks[start_index:i+1]]
                        min_zxj = min(zxjs)
                        avg_ccl = mean(ccls)                        
                        max_zxj = max(zxjs)
                        cjl = sum([x['cjlDiff'] for x in sorted_ticks[start_index:i+1]])
                        
                        m_ticks.append({
                            "time": sorted_ticks[i]['time'][:-4],
                            "code": sorted_ticks[i]['code'],
                            "max_zxj": int(max_zxj) if data_type != "i" else round(max_zxj*2)/2,
                            "min_zxj": int(min_zxj) if data_type != "i" else round(min_zxj*2)/2,
                            "ccl": int(avg_ccl),
                            "cjl": int(cjl),
                        })
                        
                    start_index = i + 1
            
            CACHE_TICKS_1MIN[data_type] = m_ticks
            
    utils.log("Finish inital ticks data")

@app.route('/ticks', methods=['GET'])
@block_ip()
def get_latest_1min_ticks():
    data = {}
    for data_type in DATA_TYPES:   
        # Update new data
        if len(CACHE_TICKS_1MIN[data_type]) >= LAST_DAY_SIZE:
            CACHE_TICKS_1MIN[data_type] = CACHE_TICKS_1MIN[data_type][-LAST_DAY_SIZE:]
        last_tick = CACHE_TICKS_1MIN[data_type][-1]
        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gte": last_tick["time"]}}).sort("time", 1))
        if len(new_ticks) >= 12:
            m_ticks = []
            start_index = 1
            for i in range(start_index, len(new_ticks)):
                if new_ticks[i]['time'][-6:] == "00.000":
                    if i - start_index > 10:
                        zxjs = [x['zxj'] for x in new_ticks[start_index:i+1]]
                        ccls = [x['ccl'] for x in new_ticks[start_index:i+1]]
                        min_zxj = min(zxjs)
                        avg_ccl = mean(ccls)                        
                        max_zxj = max(zxjs)
                        cjl = sum([x['cjlDiff'] for x in new_ticks[start_index:i+1]])
                        
                        m_ticks.append({
                            "time": new_ticks[i]['time'][:-4],
                            "code": new_ticks[i]['code'],
                            "max_zxj": int(max_zxj) if data_type != "i" else round(max_zxj*2)/2,
                            "min_zxj": int(min_zxj) if data_type != "i" else round(min_zxj*2)/2,
                            "ccl": int(avg_ccl),
                            "cjl": int(cjl),
                        })
                        
                    start_index = i + 1
            
            CACHE_TICKS_1MIN[data_type] = CACHE_TICKS_1MIN[data_type][len(m_ticks):]
            CACHE_TICKS_1MIN[data_type].extend(m_ticks)
        
        # return from cache
        data[data_type] = CACHE_TICKS_1MIN[data_type]
    
    return data

@app.route('/')
@block_ip()
@requires_auth
def index():
    return render_template('index.html')


@app.route('/info', methods=['GET'])
@block_ip()
def get_info():
    list_size = 6
    kp_time = date_utils.get_kp_time_string()
    is_working_day = date_utils.is_work_day(kp_time[:10])
    current_str = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d')
    result = {}    
            
    for data_type in DATA_TYPES:
        result[data_type] = {}    
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(FIVE_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks
        
        if len(CACHE_TICKS[data_type]) >= 1.5 * FIVE_DAYS_SIZE:
            CACHE_TICKS[data_type] = CACHE_TICKS[data_type][-FIVE_DAYS_SIZE:]
            
        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gt": CACHE_TICKS[data_type][-1]['time']}}).sort([("time", 1)]))
        if new_ticks:
            CACHE_TICKS[data_type] += new_ticks
            
        
        if data_type not in CACHE_DAILY_CCL_DATA or current_str not in CACHE_DAILY_CCL_DATA[data_type]:
            if data_type not in CACHE_DAILY_CCL_DATA or is_working_day:
                CACHE_DAILY_CCL_DATA[data_type] = analysis_helper.get_past_n_days_ccl_min_max(CACHE_TICKS[data_type], data_type, 4)
            # utils.log("CACHE_DAILY_CCL_DATA: {}".format(CACHE_DAILY_CCL_DATA[data_type]))

        result[data_type]['daily_ccl_datas'] = []
        for k, v in CACHE_DAILY_CCL_DATA[data_type].items():
            result[data_type]['daily_ccl_datas'].append([
                v['start'],
                v["close_diff"],
                v["min"],
                v["max"],
                v["diff"]                    
            ])
                    
        if is_working_day or data_type not in KP_TICKS:    
            if data_type not in KP_TICKS or kp_time != KP_TICKS[data_type]['time']:
                utils.log("kp_time: {}".format(kp_time))
                KP_TICKS[data_type] = constance.REAL_TIME_TICK_COL.find_one({"type": data_type, "time": {"$lte": kp_time}}, sort=[("time", -1)])
        
        result[data_type]['kp_info'] = [[CACHE_TICKS[data_type][-1]['code'],
            CACHE_TICKS[data_type][-1]['zxj'],
            CACHE_TICKS[data_type][-1]['ccl'],
            int(CACHE_TICKS[data_type][-1]['zxj'] - KP_TICKS[data_type]['zxj']) if data_type != 'i' else round((CACHE_TICKS[data_type][-1]['zxj'] - KP_TICKS[data_type]['zxj'])*2)/2,
            int(CACHE_TICKS[data_type][-1]['ccl'] - KP_TICKS[data_type]['ccl'])]]
        
        # Three hours ago
        source_data = CACHE_TICKS[data_type][- 12 * 60 * 3:]
        result[data_type]['zxj_infos'] = analysis_helper.get_past_min_max_infor(source_data, column="zxj")
        result[data_type]['ccl_infos'] = analysis_helper.get_past_min_max_infor(source_data, column="ccl")
        
            
        data = CACHE_TICKS[data_type][-list_size:]
        latest_ticks = []
        for i in range(1, len(data)):
            record = data[i]
            latest_ticks.append(
                [record['time'][11:-4], record['zxj'] if data_type == 'i' else int(record['zxj']), int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']), int(data[i]['ccl'] - data[i - 1]['ccl']), int(record['ccl'])]
            )
        
        result[data_type]['ticks'] = latest_ticks
        
        result[data_type]['sum_infos'] = f"open time {KP_TICKS[data_type]['time'][5:-4]}"
        
    
    # processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    # current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    
         
    return result

if __name__ == '__main__':
    initial_ticks()
    app.run(debug=False, host='0.0.0.0', port=8080)
