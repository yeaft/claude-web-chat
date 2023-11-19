from flask import Flask, request, render_template,Response
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import v3_keep_doing
from datetime import datetime, timedelta
import time, pytz
from pymongo import MongoClient, DESCENDING, ASCENDING
from functools import wraps
from statistics import mean
from flask_compress import Compress

app = Flask(__name__)
Compress(app)

CACHE_TICKS = {}
CACHE_TICKS_1MIN = {}
CACHE_DAILY_CCL_DATA = {}
CACHE_CP_RATE_DATA = {}
PAST_CCL_STABLE_DATA = {}
FIVE_DAYS_SIZE = int(12 * 60 * 5.8 * 5)
LAST_DAY_SIZE = int(12 * 60 * 5.8)
KP_INDEX = 0
LAST_KP_TIME = ""
DATA_TYPES= ['rb', 'i', 'oi', 'y']
    
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
def get_latest_1min_ticks():
    data = {}
    for data_type in DATA_TYPES:   
        # Update new data     
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
                
            CACHE_TICKS_1MIN[data_type].extend(m_ticks)
        
        # return from cache
        data[data_type] = CACHE_TICKS_1MIN[data_type]
    
    return data

@app.route('/')
@requires_auth
def index():
    return render_template('index.html')


@app.route('/info', methods=['GET'])
def get_info():
    # Check if the type is one of the allowed types    
    start_time = time.time()
    list_size = 6
    kp_index = -1
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
            LAST_KP_TIME = ""
            
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
                    
        if is_working_day:    
            if kp_time != LAST_KP_TIME:
                for i in range(int(len(CACHE_TICKS[data_type]) - LAST_DAY_SIZE), len(CACHE_TICKS[data_type])):
                    if CACHE_TICKS[data_type][i]['time'] >= kp_time:
                        kp_index = i
                        break
                LAST_KP_TIME = kp_time
                KP_INDEX = kp_index
        else:
            KP_INDEX = len(CACHE_TICKS[data_type]) - 1
        
        # KP info
        kp_tick = CACHE_TICKS[data_type][KP_INDEX]
        # result[data_type]['kp_info'] = {
        #     # "kp_zxj": kp_tick['zxj'],
        #     "code": CACHE_TICKS[data_type][-1]['code'],
        #     "cur_zxj": CACHE_TICKS[data_type][-1]['zxj'],
        #     # "kp_ccl": kp_tick['ccl'],
        #     "cur_ccl": CACHE_TICKS[data_type][-1]['ccl'],
        #     "zxj_diff": int(CACHE_TICKS[data_type][-1]['zxj'] - kp_tick['zxj']) if data_type != 'i' else round((CACHE_TICKS[data_type][-1]['zxj'] - kp_tick['zxj'])*2)/2,
        #     "ccl_diff": int(CACHE_TICKS[data_type][-1]['ccl'] - kp_tick['ccl']),
        # }
        
        result[data_type]['kp_info'] = [[CACHE_TICKS[data_type][-1]['code'],
            CACHE_TICKS[data_type][-1]['zxj'],
            CACHE_TICKS[data_type][-1]['ccl'],
            int(CACHE_TICKS[data_type][-1]['zxj'] - kp_tick['zxj']) if data_type != 'i' else round((CACHE_TICKS[data_type][-1]['zxj'] - kp_tick['zxj'])*2)/2,
            int(CACHE_TICKS[data_type][-1]['ccl'] - kp_tick['ccl'])]]
        
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
        
        result[data_type]['sum_infos'] = f"open time {kp_tick['time'][5:-4]}"
        
    
    # processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    # current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    
         
    return result

@app.route('/lagecy', methods=['GET'])
@requires_auth
def get_latest_data():
    # Check if the type is one of the allowed types    
    start_time = time.time()
    results = {}
    zxj_infos = {}
    ccl_infos = {}
    list_size = 6

    kp_index = -1
    # data_types = ['rb']
    # kp_time = date_utils.get_kp_time_string("2023-10-31")
    kp_time = date_utils.get_kp_time_string()
    is_working_day = date_utils.is_work_day(kp_time[:10])
    kp_info = {}
    current_str = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d')
    daily_ccl_datas = {}
    sum_infos = {}
    stable_ccl_datas = {}
    
            
    for data_type in DATA_TYPES:        
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(FIVE_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks
        
        if len(CACHE_TICKS[data_type]) >= 1.5 * FIVE_DAYS_SIZE:
            CACHE_TICKS[data_type] = CACHE_TICKS[data_type][-FIVE_DAYS_SIZE:]
            LAST_KP_TIME = ""
            
        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gt": CACHE_TICKS[data_type][-1]['time']}}).sort([("time", 1)]))
        if new_ticks:
            CACHE_TICKS[data_type] += new_ticks
            
        
        if data_type not in CACHE_DAILY_CCL_DATA or current_str not in CACHE_DAILY_CCL_DATA[data_type]:
            if data_type not in CACHE_DAILY_CCL_DATA or is_working_day:
                CACHE_DAILY_CCL_DATA[data_type] = analysis_helper.get_past_n_days_ccl_min_max(CACHE_TICKS[data_type], data_type, 4)
            # utils.log("CACHE_DAILY_CCL_DATA: {}".format(CACHE_DAILY_CCL_DATA[data_type]))

        daily_ccl_datas[data_type] = []
        for k, v in CACHE_DAILY_CCL_DATA[data_type].items():
            daily_ccl_datas[data_type].append({
                # "date": k[5:],
                "start": v["start"],
                "close_d": v["close_diff"],
                "min": v["min"],
                "max": v["max"],
                "mm_c": v["diff"]           
            })
        
        # Get CP rate
        # if data_type not in CACHE_CP_RATE_DATA or current_str not in CACHE_CP_RATE_DATA[data_type]:
        #     CACHE_CP_RATE_DATA[data_type] = {}
        #     CACHE_CP_RATE_DATA[data_type][current_str] = analysis_helper.get_cp_rate_by_exrema_price(CACHE_TICKS[data_type])
        #     # utils.log("CACHE_CP_RATE_DATA: {}".format(CACHE_CP_RATE_DATA[data_type]))

        # cp_infos[data_type] = ""
        # for cp_rate in CACHE_CP_RATE_DATA[data_type][current_str]:
        #     cp_infos[data_type] += f"{cp_rate['rate_type']}: {cp_rate['cp_avg']},{cp_rate['cp_std']},{cp_rate['count']} | "
        
        # cp_infos[data_type] = cp_infos[data_type][:-3]
        
        # Calculate stable data
        # if data_type not in PAST_CCL_STABLE_DATA or "00:00.000" in CACHE_TICKS[data_type][-1]['time'] :
        #     PAST_CCL_STABLE_DATA[data_type] = analysis_helper.get_stable_ccl_time(CACHE_TICKS[data_type])
        
        # stable_ccl_datas[data_type] = [[],[],[],[]]
        # for i in range(-min(6, len(PAST_CCL_STABLE_DATA[data_type])), 0):
        #     stable_ccl = PAST_CCL_STABLE_DATA[data_type][i]
        #     last_stable_ccl = PAST_CCL_STABLE_DATA[data_type][i - 1]
        #     stable_ccl_datas[data_type][0].append(stable_ccl['end_time'][11:-4])
        #     stable_ccl_datas[data_type][1].append(stable_ccl['avg_zxj'])
        #     stable_ccl_datas[data_type][2].append(stable_ccl['avg_ccl'])
        #     stable_ccl_datas[data_type][3].append(f"{stable_ccl['avg_ccl'] - last_stable_ccl['avg_ccl']}/{int(stable_ccl['avg_zxj'] - last_stable_ccl['avg_zxj'])}")
            
            
        if is_working_day:    
            if kp_time != LAST_KP_TIME:
                for i in range(int(len(CACHE_TICKS[data_type]) - 12 * 60 * 5.8), len(CACHE_TICKS[data_type])):
                    if CACHE_TICKS[data_type][i]['time'] >= kp_time:
                        kp_index = i
                        break
                LAST_KP_TIME = kp_time
                KP_INDEX = kp_index
        else:
            KP_INDEX = len(CACHE_TICKS[data_type]) - 1
        
        # KP info
        kp_tick = CACHE_TICKS[data_type][KP_INDEX]
        kp_info[data_type] = {
            # "kp_zxj": kp_tick['zxj'],
            "code": CACHE_TICKS[data_type][-1]['code'],
            "cur_zxj": CACHE_TICKS[data_type][-1]['zxj'],
            # "kp_ccl": kp_tick['ccl'],
            "cur_ccl": CACHE_TICKS[data_type][-1]['ccl'],
            "zxj_diff": int(CACHE_TICKS[data_type][-1]['zxj'] - kp_tick['zxj']) if data_type != 'i' else round((CACHE_TICKS[data_type][-1]['zxj'] - kp_tick['zxj'])*2)/2,
            "ccl_diff": int(CACHE_TICKS[data_type][-1]['ccl'] - kp_tick['ccl']),
        }
        
        # Three hours ago
        source_data = CACHE_TICKS[data_type][- 12 * 60 * 3:]
        zxj_infos[data_type] = analysis_helper.get_past_min_max_infor(source_data, column="zxj")
        ccl_infos[data_type] = analysis_helper.get_past_min_max_infor(source_data, column="ccl")
        
            
        data = CACHE_TICKS[data_type][-list_size:]
        result = []
        for i in range(1, len(data)):
            record = data[i]
            result.append(
                {
                    "time": record['time'][11:-4],
                    # "code": record['code'],
                    "zxj": record['zxj'] if data_type == 'i' else int(record['zxj']),
                    "cjl": int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']),
                    "zjl": int(data[i]['ccl'] - data[i - 1]['ccl']),
                    "ccl": int(record['ccl']),
                }
            )
        
        results[data_type] = result
        
        sum_infos[data_type] = f"open time {kp_tick['time'][5:-4]}"
        
    
    processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    if results:        
        return render_template('data.html', sum_infos = sum_infos, kp_info = kp_info, daily_ccl_datas= daily_ccl_datas, zxj_infos=zxj_infos, ccl_infos = ccl_infos, data=results, processing_time=processing_time, openning_time=kp_time[5:-4], current_time=current_time[5:-4])
    else:
        return "No data found for the given type", 404

if __name__ == '__main__':
    initial_ticks()
    app.run(debug=False, host='0.0.0.0', port=8080)
