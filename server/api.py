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
            find_extremes(data_type, CACHE_TICKS[data_type], cols = ["ccl", "zxj"])
            find_extremes(data_type, CACHE_TICKS[data_type], span = 20 * 12, cols = ["cjlDiff"])
            global FIND_PEAK_START_INDEX
            FIND_PEAK_START_INDEX = len(CACHE_TICKS[data_type]) - 45 * 12
            
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

def find_extremes(data_type, tick_infos, span = 45 * 12, cols = []):
    global FIND_PEAK_START_INDEX
    FIND_PEAK_START_INDEX = max(FIND_PEAK_START_INDEX, span)
    end_index = len(tick_infos) - int(0.6 * span) if "cjlDiff" not in cols else len(tick_infos)
    for i in range(FIND_PEAK_START_INDEX, end_index):
        # 确定窗口边界
        start = i - span
        end = i + span + 1

        # 当前值
        if not cols:
            cols = EXTREME_COLS
        for col in cols:
            if col not in tick_infos[i]:
                continue
                
            extremes = EXTREME_SET[data_type][col]
            current_value = tick_infos[i][col]
            max_value = max(t[col] for t in tick_infos[start:end] if col in t)
            
            if 'cjl' in col:
                if current_value == max_value and current_value >= MIN_CJL_5SEC_THRESHOLD and (len(extremes) == 0 or i > extremes[-1]['index']):
                    extreme = {
                        "extreme": "max",
                        "index": i,
                    }
                    is_added = False
                    if len(extremes) > 0 and i - extremes[-1]['index'] < 12 * 10:
                        if current_value >= tick_infos[extremes[-1]['index']][col]:
                            extremes[-1] = extreme
                            is_added = True
                    else:
                        extremes.append(extreme)
                        is_added = True
                    
                    if is_added:
                        start_index, end_index = find_hot_period_with_step(tick_infos, i)
                        extremes[-1]['start_index'] = start_index
                        extremes[-1]['end_index'] = end_index
            else:
                min_value = min(t[col] for t in tick_infos[start:end] if col in t)        
                # 检查是否为最高或最低值
                if current_value == max_value and (len(extremes) == 0 or i > extremes[-1]['index']):
                    extreme = {
                        "extreme": "max",
                        "index": i,
                    }
                    if len(extremes) > 0 and extremes[-1]['extreme'] == 'max':
                        if current_value >= tick_infos[extremes[-1]['index']][col]:
                            extremes[-1] = extreme
                    else:
                        extremes.append(extreme)
                elif current_value == min_value and (len(extremes) == 0 or i > extremes[-1]['index']):
                    extreme = {
                        "extreme": "min",
                        "index": i,
                    }
                    if len(extremes) > 0 and extremes[-1]['extreme'] == 'min':
                        if  current_value <= tick_infos[extremes[-1]['index']][col]:
                            extremes[-1] = extreme
                    else:
                        extremes.append(extreme)


def find_hot_period_with_step(data, initial_index, window=6, step=3):
    start_index = initial_index
    end_index = initial_index

    # 向左扩展
    while start_index >= step and sum_within_window(data, start_index - step, window) >= LOW_CJL_MINUTE_THRESHOLD:
        start_index -= step

    # 如果跳出循环后当前点不满足条件，可能需要向右调整至满足条件的点
    while start_index < len(data) and sum_within_window(data, start_index, window) < LOW_CJL_MINUTE_THRESHOLD:
        start_index += 1

    # 向右扩展
    while end_index + step < len(data) and sum_within_window(data, end_index + step, window) >= LOW_CJL_MINUTE_THRESHOLD:
        end_index += step

    # 如果跳出循环后当前点不满足条件，可能需要向左调整至满足条件的点
    end_index = min(end_index, len(data)-1)
    while end_index >= 0 and sum_within_window(data, end_index, window) < LOW_CJL_MINUTE_THRESHOLD:
        end_index -= 1

    return start_index, end_index

def sum_within_window(data, index, window=6):
    start = max(index - window, 0)
    end = min(index + window, len(data) - 1)
    return np.sum([tick['cjlDiff'] for tick in data[start:end+1] if "cjlDiff" in tick])    
        
@app.route('/ticks', methods=['GET'])
@block_ip()
def get_latest_1min_ticks():
    data = {}
    for data_type in DATA_TYPES:   
        # Update new data
        if len(CACHE_TICKS_1MIN[data_type]) >= TEN_DAYS_SIZE:
            CACHE_TICKS_1MIN[data_type] = CACHE_TICKS_1MIN[data_type][-TEN_DAYS_SIZE:]
        last_tick = CACHE_TICKS_1MIN[data_type][-1]
        last_index = len(CACHE_TICKS_1MIN[data_type])
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
    global FIND_PEAK_START_INDEX
    start_time = time.time()
    list_size = 11
    kp_time = date_utils.get_kp_time_string()
    is_working_day = date_utils.is_work_day(kp_time[:10])
    current_str = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d')
    result = {}    
            
    for data_type in DATA_TYPES:
        result[data_type] = {}    
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(TEN_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks
        
        if len(CACHE_TICKS[data_type]) >= 1.2 * TEN_DAYS_SIZE:
            CACHE_TICKS[data_type] = CACHE_TICKS[data_type][-TEN_DAYS_SIZE:]
            FIND_PEAK_START_INDEX = 0
            EXTREME_SET[data_type]['ccl'] = []
            EXTREME_SET[data_type]['zxj'] = []
            EXTREME_SET[data_type]['cjlDiff'] = []
            find_extremes(data_type, CACHE_TICKS[data_type], cols = ["ccl", "zxj"])
            find_extremes(data_type, CACHE_TICKS[data_type], span = 20 * 12, cols = ["cjlDiff"])
            
        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gt": CACHE_TICKS[data_type][-1]['time']}}).sort([("time", 1)]))
        if new_ticks:
            CACHE_TICKS[data_type] += new_ticks
            
            find_extremes(data_type, CACHE_TICKS[data_type], cols = ['ccl', 'zxj'])
            find_extremes(data_type, CACHE_TICKS[data_type], span = 20 * 12, cols = ['cjlDiff'])
            FIND_PEAK_START_INDEX = len(CACHE_TICKS[data_type]) - 45 * 12        
        
        for col in EXTREME_COLS:
            peaks = []
            size = 8 if col == "ccl" else 6
            for i in range(1, len(EXTREME_SET[data_type][col][-size:])):
                extreme = EXTREME_SET[data_type][col][-size:][i]
                last_extreme = EXTREME_SET[data_type][col][-size:][i - 1]
                extreme_tick = CACHE_TICKS[data_type][extreme['index']]
                last_extreme_tick = CACHE_TICKS[data_type][last_extreme['index']]
                if col == "ccl":
                    peaks.append([extreme_tick['time'][-18:-7], extreme_tick['ccl'], int(extreme_tick['ccl'] - last_extreme_tick['ccl']), int(extreme_tick['zxj'] - last_extreme_tick['zxj']), extreme_tick['zxj']])
                elif col == "zxj":
                    peaks.append([extreme_tick['time'][-18:-7], extreme_tick['zxj'], int(extreme_tick['zxj'] - last_extreme_tick['zxj']), int(extreme_tick['ccl'] - last_extreme_tick['ccl']), extreme_tick['ccl']])
                else:
                    start_tick = CACHE_TICKS[data_type][extreme['start_index']]
                    end_tick = CACHE_TICKS[data_type][extreme['end_index']]
                    minuts_diff = f"{round((extreme['end_index']-extreme['start_index']) / 12, 1)}m"
                    cjl_sum = sum(tick['cjlDiff'] for tick in CACHE_TICKS[data_type][extreme['start_index']:extreme['end_index']+1])
                    # cjl_per_min = round(cjl_sum / (extreme['end_index']-extreme['start_index']) * 12)
                    peak_price = max([tick['zxj'] for tick in CACHE_TICKS[data_type][extreme['start_index']:extreme['end_index']+1]]) if extreme_tick['zxj'] >= start_tick['zxj'] else min([tick['zxj'] for tick in CACHE_TICKS[data_type][extreme['start_index']:extreme['end_index']+1]])
                    # symbol = "↑"
                    # if end_tick['zxj'] == start_tick['zxj']:
                    #     if peak_price < start_tick['zxj']:
                    #         symbol = "↓"
                    # elif end_tick['zxj'] < start_tick['zxj']:
                    #     symbol = "↓"
                    end_diff = int(end_tick['zxj'] - start_tick['zxj'])
                    # peak_diff = int(peak_price - start_tick['zxj']) 
                    peaks.append([f"{start_tick['time'][-12:-7]}-{end_tick['time'][-12:-7]}", f"{int(start_tick['zxj'])}/{end_diff}", f"{int(peak_price)}", minuts_diff, cjl_sum])
                # ccl_peaks.append([extreme_tick['time'][-18:-4], extreme_tick['ccl'], int(extreme_tick['ccl'] - last_extreme_tick['ccl']), extreme_tick['zxj'], int(extreme_tick['zxj'] - last_extreme_tick['zxj']), sum(tick['cjlDiff'] for tick in CACHE_TICKS[data_type][last_extreme['index']+1:extreme['index']] if 'cjlDiff' in tick)])

            last_extreme = EXTREME_SET[data_type][col][-1]
            last_extreme_tick = CACHE_TICKS[data_type][last_extreme['index']]
            if col == "ccl":                
                peaks.append([CACHE_TICKS[data_type][-1]['time'][-18:-7], CACHE_TICKS[data_type][-1]['ccl'], int(CACHE_TICKS[data_type][-1]['ccl'] - last_extreme_tick['ccl']), int(CACHE_TICKS[data_type][-1]['zxj'] - last_extreme_tick['zxj']), CACHE_TICKS[data_type][-1]['zxj']])
            elif col == "zxj":
                peaks.append([CACHE_TICKS[data_type][-1]['time'][-18:-7], CACHE_TICKS[data_type][-1]['zxj'], int(CACHE_TICKS[data_type][-1]['zxj'] - last_extreme_tick['zxj']), int(CACHE_TICKS[data_type][-1]['ccl'] - last_extreme_tick['ccl']), CACHE_TICKS[data_type][-1]['ccl']])
            result[data_type][f'{col}_peaks'] = peaks
        
        
        # if data_type not in CACHE_DAILY_CCL_DATA or current_str not in CACHE_DAILY_CCL_DATA[data_type]:
        #     if data_type not in CACHE_DAILY_CCL_DATA or is_working_day:
        #         CACHE_DAILY_CCL_DATA[data_type] = analysis_helper.get_past_n_days_ccl_min_max(CACHE_TICKS[data_type], data_type, 6)
        #     # utils.log("CACHE_DAILY_CCL_DATA: {}".format(CACHE_DAILY_CCL_DATA[data_type]))

        # result[data_type]['daily_ccl_datas'] = CACHE_DAILY_CCL_DATA[data_type]
                            
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
        # result[data_type]['peak_infos'] = analysis_helper.get_past_peaks_info(CACHE_TICKS[data_type][-HALF_DAY_SIZE:])
        # result[data_type]['zxj_infos'] = [analysis_helper.get_past_min_max_infor(source_data, column="zxj")[1]]
        # result[data_type]['ccl_infos'] = [analysis_helper.get_past_min_max_infor(source_data, column="ccl")[2]]
        
            
        data = CACHE_TICKS[data_type][-list_size:]
        latest_ticks = []
        for i in range(1, len(data)):
            record = data[i]
            latest_ticks.append(
                [record['time'][11:-4], record['zxj'] if data_type == 'i' else int(record['zxj']), int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']), int(data[i]['ccl'] - data[i - 1]['ccl']), int(record['ccl'])]
            )
        
        result[data_type]['ticks'] = latest_ticks
        
        ccl_sums = []
        for i in range(5, 0, -1):
            start_index = - i * 12
            end_index = - (i - 1) * 12 if i != 1 else len(CACHE_TICKS[data_type])            
            ccl_sums.append(sum(tick['cjlDiff'] for tick in CACHE_TICKS[data_type][start_index:end_index]))
            

        result[data_type]['ccl_sums'] = [ccl_sums]
        
        # result[data_type]['sum_infos'] = f"open time {KP_TICKS[data_type]['time'][5:-4]}"
        
    
    processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    # current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    
    utils.log("processing_time: {}".format(processing_time))
    return result

if __name__ == '__main__':
    initial_ticks()
    app.run(debug=False, host='0.0.0.0', port=8080)
