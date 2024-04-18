from flask import Flask, request, render_template,Response, abort
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
import ipaddress
from datetime import datetime, timedelta
import time, pytz
from functools import wraps
from statistics import mean
from flask_compress import Compress
from functools import wraps
import numpy as np

app = Flask(__name__)
Compress(app)

CACHE_TICKS = {}
CACHE_TICKS_1MIN = {}
CACHE_DAILY_CCL_DATA = {}
CACHE_CP_RATE_DATA = {}
PAST_CCL_STABLE_DATA = {}
TEN_DAYS_SIZE = int(12 * 60 * 5.8 * 10)
TEN_DAYS_MINS_SIZE = int(60 * 5.8 * 10)
LAST_DAY_SIZE = int(12 * 60 * 5.8)
HALF_DAY_SIZE = int(12 * 60 * 3)
KP_TICKS = {}
DATA_TYPES= ['rb']
BLOCKED_PATTERNS = [
    "45.128.*.*",
    "141.98.*.*"
]
FIND_PEAK_START_INDEX = 0
EXTREME_COLS = ["ccl", "zxj", "cjlDiff"]
EXTREME_SET = {}
LOW_CJL_MINUTE_THRESHOLD = 3000
MIN_CJL_5SEC_THRESHOLD = 1500
# CANDIDATE_CODES = ["rb2401", "rb2405", "rb2410", "ii2401", "ii2405", "ii2410"]
CANDIDATE_CODES = ["rb2401", "rb2405"]
CODE = "rb2401"
CONTEXT = {
}

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
    for code in CANDIDATE_CODES:        
        if code not in CONTEXT:            
            ticks = list(constance.REAL_TIME_TICK_COL.find({"code": code}).sort([("time", 1)]))
            start_index = 0
            m_ticks = []
            for i in range(len(ticks)):
                if ticks[i]['time'][-6:] == "00.000":
                    if i - start_index > 10:
                        zxjs = [x['zxj'] for x in ticks[start_index:i+1]]
                        ccls = [x['ccl'] for x in ticks[start_index:i+1]]
                        min_zxj = min(zxjs)
                        avg_ccl = mean(ccls)                        
                        max_zxj = max(zxjs)
                        cjl = sum([x['cjlDiff'] for x in ticks[start_index:i+1] if 'cjlDiff' in x])
                        
                        m_ticks.append({
                            "time": ticks[i]['time'][:-4],
                            "code": ticks[i]['code'],
                            "max_zxj": int(max_zxj) if "i" in code else round(max_zxj*2)/2,
                            "min_zxj": int(min_zxj) if "i" in code else round(min_zxj*2)/2,
                            "ccl": int(avg_ccl),
                            "cjl": int(cjl),
                        })
                        
                    start_index = i + 1
            
            CONTEXT[code] = {
                "index": TEN_DAYS_SIZE,
                "ticks": ticks,
                "min_index": 0,
                "min_ticks": m_ticks
            }
            print(f"Finish inital ticks data for {code}, total ticks: {len(ticks)}, total min ticks: {len(m_ticks)}")
            
    utils.log("Finish inital ticks data")

        
@app.route('/train')
@block_ip()
@requires_auth
def train():
    return render_template('train.html')
    
@app.route('/train/data', methods=['GET'])
@block_ip()
def get_info():
    list_size = 65 
    next = request.args.get('next', default=1, type=int)  # Retrieve next_count from the query string 
    next_index = CONTEXT[CODE]["index"] + next
    CONTEXT[CODE]["index"] = next_index
    result = {
        "rb": {},
    }  
    data_type = "rb"  
            
    data = CONTEXT[CODE]["ticks"][next_index-list_size:next_index]
    latest_ticks = []
    for i in range(1, len(data)):
        record = data[i]
        latest_ticks.append(
            [record['time'][11:-4], record['zxj'] if data_type == 'i' else int(record['zxj']), int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']), int(data[i]['ccl'] - data[i - 1]['ccl']), int(record['ccl'])]
        )
    
    result[data_type]['ticks'] = latest_ticks[-24:]
        
    ccl_sums = []
    for i in range(5, 0, -1):
        start_index = - i * 12
        end_index = - (i - 1) * 12 if i != 1 else len(data)            
        ccl_sums.append(sum(tick['cjlDiff'] for tick in data[start_index:end_index]))
            

    result[data_type]['ccl_sums'] = [ccl_sums]
    
    
    # Find end_index
    last_index = CONTEXT[CODE]["min_index"]
    end_tick = data[-1]
    end_index = -1
    for i in range(last_index, len(CONTEXT[CODE]['min_ticks'])):
        # print(f"{CONTEXT[CODE]['min_ticks'][i]['time']} == {end_tick['time'][:-4]} at {i}, start_index: {last_index}, end_index: {i}")
        if CONTEXT[CODE]['min_ticks'][i]['time'][:-2] == end_tick['time'][:-6]:
            print(f"{CONTEXT[CODE]['min_ticks'][i]['time']} == {end_tick['time'][:-4]} at {i}, start_index: {last_index}, end_index: {i}")
            end_index = i    
            break
    

    start_index = max(0, end_index - TEN_DAYS_MINS_SIZE)
    print(f"Get latest 1min ticks for {CODE}, start_index: {start_index}, next_index: {end_index}, min_ticks: {len(CONTEXT[CODE]['min_ticks'])}")
    result[data_type]['chart_ticks'] = CONTEXT[CODE]["min_ticks"][start_index:end_index]
    CONTEXT[CODE]["min_index"] = end_index
    
    
    return result

if __name__ == '__main__':
    initial_ticks()
    app.run(debug=False, host='0.0.0.0', port=8080)
