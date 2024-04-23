from flask import Flask, request, render_template,Response, abort
from helper import constance, date_utils, utils
import ipaddress
import time
from functools import wraps
from statistics import mean
from flask_compress import Compress
from functools import wraps
import random

app = Flask(__name__)
Compress(app)

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

CANDIDATE_CODES = ["rb2401"]

CONTEXT = {
    "default_code": "rb2401"
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
    for data_type in DATA_TYPES:        
        if data_type not in CACHE_TICKS:
            if data_type not in EXTREME_SET:
                EXTREME_SET[data_type] = {'ccl':[], 'zxj':[], 'cjlDiff':[]}
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(TEN_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks            
            
            m_ticks = []
            start_index = 0
            for i in range(len(sorted_ticks)):
                if sorted_ticks[i]['time'][-6:] == "00.000":
                    if i - start_index > 10:
                        zxjs = [x['zxj'] for x in sorted_ticks[start_index:i+1]]
                        ccls = [x['ccl'] for x in sorted_ticks[start_index:i+1]]
                        min_zxj = min(zxjs)
                        avg_ccl = mean(ccls)                        
                        max_zxj = max(zxjs)
                        cjl = sum([x['cjlDiff'] for x in sorted_ticks[start_index:i+1] if 'cjlDiff' in x])
                        
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
            
    utils.log("Finish inital real ticks data")
    utils.log("Start to initial training data")
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
            
            train_status = constance.TRAIN_COL.find_one({"code": code}) 
            if train_status is None:
                tick_index = TEN_DAYS_SIZE
                min_index = 0
            else:
                tick_index = train_status['index']
                min_index = train_status['min_index']
            
            CONTEXT[code] = {
                "index": tick_index,
                "ticks": ticks,
                "min_index": min_index,
                "min_ticks": m_ticks
            }
            
            print(f"Finish inital ticks data for {code}, total ticks: {len(ticks)}, total min ticks: {len(m_ticks)}")
            
    utils.log("Finish inital train ticks data")

def save_train_status(code):
    constance.TRAIN_COL.update_one({"code": code}, {"$set": {"index": CONTEXT[code]['index'], "min_index": CONTEXT[code]['min_index']}}, upsert=True)
    
    
@app.route('/ticks', methods=['GET'])
@block_ip()
def get_latest_1min_ticks():
    data = {}
    for data_type in DATA_TYPES:   
        # Update new data
        if len(CACHE_TICKS_1MIN[data_type]) >= TEN_DAYS_SIZE:
            CACHE_TICKS_1MIN[data_type] = CACHE_TICKS_1MIN[data_type][-TEN_DAYS_SIZE:]
        last_tick = CACHE_TICKS_1MIN[data_type][-1]
        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gte": last_tick["time"]}}).sort("time", 1))
        is_updated = False
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
            is_updated = True
        
        # return from cache
        data[data_type] = list(CACHE_TICKS_1MIN[data_type])
        if not is_updated and len(new_ticks) > 0 and new_ticks[-1] != last_tick:
            zxjs = [x['zxj'] for x in new_ticks]
            ccls = [x['ccl'] for x in new_ticks]
            min_zxj = min(zxjs)
            avg_ccl = mean(ccls)                        
            max_zxj = max(zxjs)
            cjl = sum([x['cjlDiff'] for x in new_ticks])
            data[data_type].append({
                            "time": new_ticks[-1]['time'][:-4],
                            "code": new_ticks[-1]['code'],
                            "max_zxj": int(max_zxj) if data_type != "i" else round(max_zxj*2)/2,
                            "min_zxj": int(min_zxj) if data_type != "i" else round(min_zxj*2)/2,
                            "ccl": int(avg_ccl),
                            "cjl": int(cjl),
                        })
    
    return data

@app.route('/')
@block_ip()
@requires_auth
def index():
    return render_template('index.html')

@app.route('/test_ding', methods=['GET'])
@block_ip()
def test_ding():
    utils.send_ding_msg("test")
    return {"status": "ok"}
    
    
@app.route('/info', methods=['GET'])
@block_ip()
def get_info():
    start_time = time.time()
    list_size = 26
    kp_time = date_utils.get_kp_time_string()
    is_working_day = date_utils.is_work_day(kp_time[:10])
    result = {}    
            
    for data_type in DATA_TYPES:
        result[data_type] = {}    
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(TEN_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks
        
        if len(CACHE_TICKS[data_type]) >= 1.2 * TEN_DAYS_SIZE:
            CACHE_TICKS[data_type] = CACHE_TICKS[data_type][-TEN_DAYS_SIZE:]

        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gt": CACHE_TICKS[data_type][-1]['time']}}).sort([("time", 1)]))
        if new_ticks:
            CACHE_TICKS[data_type] += new_ticks
                      
        if is_working_day or data_type not in KP_TICKS:    
            if data_type not in KP_TICKS or kp_time != KP_TICKS[data_type]['time']:
                utils.log("kp_time: {}".format(kp_time))
                KP_TICKS[data_type] = constance.REAL_TIME_TICK_COL.find_one({"type": data_type, "time": {"$lte": kp_time}}, sort=[("time", -1)])
        
        result[data_type]['kp_info'] = [[CACHE_TICKS[data_type][-1]['code'],
            CACHE_TICKS[data_type][-1]['zxj'],
            CACHE_TICKS[data_type][-1]['ccl'],
            int(CACHE_TICKS[data_type][-1]['zxj'] - KP_TICKS[data_type]['zxj']) if data_type != 'i' else round((CACHE_TICKS[data_type][-1]['zxj'] - KP_TICKS[data_type]['zxj'])*2)/2,
            int(CACHE_TICKS[data_type][-1]['ccl'] - KP_TICKS[data_type]['ccl'])]]
            
        data = CACHE_TICKS[data_type][-list_size:]
        latest_ticks = []
        for i in range(1, len(data)):
            record = data[i]
            latest_ticks.append(
                [record['time'][11:-4], record['zxj'] if data_type == 'i' else int(record['zxj']), int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']), int(data[i]['ccl'] - data[i - 1]['ccl']), int(record['ccl'])]
            )
        
        result[data_type]['ticks'] = latest_ticks
        
        ccl_sums = []
        for i in range(10, 0, -1):
            start_index = - i * 12
            end_index = - (i - 1) * 12 if i != 1 else len(CACHE_TICKS[data_type])            
            ccl_sums.append(sum(tick['cjlDiff'] for tick in CACHE_TICKS[data_type][start_index:end_index]))
            

        result[data_type]['ccl_sums'] = [ccl_sums[:5], ccl_sums[5:]]
        
        # result[data_type]['sum_infos'] = f"open time {KP_TICKS[data_type]['time'][5:-4]}"
        
    
    processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    # current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    
    utils.log("processing_time: {}".format(processing_time))
    return result

@app.route('/train')
@block_ip()
@requires_auth
def train():
    return render_template('train.html')
    
@app.route('/train/data', methods=['GET'])
@block_ip()
def get_train_info():
    start_time = time.time()
    list_size = 65 
    next = request.args.get('next', default=1, type=int)  # Retrieve next_count from the query string 
    code = request.args.get('code', default=CONTEXT["default_code"], type=str)  # Retrieve next_count from the query string
    is_random = request.args.get('random', default=False, type=bool)  # Retrieve next_count from the query string
    CONTEXT["default_code"] = code    
    
    if "rb" in code:
        data_type = "rb"
    elif "i" in code:
        data_type = "i"
    elif "hc" in code:
        data_type = "hc"
    else:
        return {"error": "Invalid code"}
    
    # print(f"Get info for {code}, next: {next}, candidate codes: {CANDIDATE_CODES}, context codes: {CONTEXT.keys()}")
    
    result = {
        data_type: {},
    }
    
    if is_random:
        CONTEXT[code]["index"] = random.randint(TEN_DAYS_SIZE, len(CONTEXT[code]["ticks"]) - TEN_DAYS_SIZE)
        CONTEXT[code]["min_index"] = int(CONTEXT[code]["index"] / 12 - 150)
    
    next_index = CONTEXT[code]["index"] + next
    CONTEXT[code]["index"] = next_index        
    data = CONTEXT[code]["ticks"][next_index-list_size:next_index]
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
    last_index = CONTEXT[code]["min_index"]
    end_tick = data[-1]
    end_index = -1
    for i in range(last_index, len(CONTEXT[code]['min_ticks'])):
        # print(f"{CONTEXT[code]['min_ticks'][i]['time']} == {end_tick['time'][:-4]} at {i}, start_index: {last_index}, end_index: {i}")
        if CONTEXT[code]['min_ticks'][i]['time'][:-2] == end_tick['time'][:-6]:
            # print(f"{CONTEXT[code]['min_ticks'][i]['time']} == {end_tick['time'][:-4]} at {i}, start_index: {last_index}, end_index: {i}")
            end_index = i    
            break
    

    start_index = max(0, end_index - FIVE_DAYS_MINS_SIZE)
    result[data_type]['chart_ticks'] = CONTEXT[code]["min_ticks"][start_index:end_index]
    CONTEXT[code]["min_index"] = end_index
    
    save_train_status(code)
    print(f"Finish get_info in {round((time.time() - start_time)*1000,2)}ms")
    return result

@app.route('/train/operate', methods=['GET'])
@block_ip()
def record_operate():
    operation = request.args.get('operation', default="", type=str)  # Retrieve next_count from the query string 
    code = CONTEXT["default_code"]
    tick_now = CONTEXT[code]["ticks"][CONTEXT[code]["index"]]
    operation_info = {
        "train_time": date_utils.get_today_time_string(),
        "operation": operation,        
        "code": code,
        "time": tick_now['time'],
        "zxj": tick_now['zxj'],
    }
    constance.TRAIN_OPT_COL.insert_one(operation_info)
    return {"status": "success", "operation": operation, "time": tick_now['time']}

if __name__ == '__main__':
    initial_ticks()
    app.run(debug=False, host='0.0.0.0', port=8080)
