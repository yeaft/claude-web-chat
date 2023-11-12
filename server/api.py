from flask import Flask, request, render_template
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import v3_keep_doing
from datetime import datetime, timedelta
import time, pytz
from pymongo import MongoClient, DESCENDING, ASCENDING

app = Flask(__name__)

global CACHE_TICKS, CACHE_DAILY_CCL_DATA, CACHE_CP_RATE_DATA, PAST_CCL_STABLE_DATA, KP_INDEX, LAST_KP_TIME
CACHE_TICKS = {}
CACHE_DAILY_CCL_DATA = {}
CACHE_CP_RATE_DATA = {}
PAST_CCL_STABLE_DATA = {}
FIVE_DAYS_SIZE = 12 * 60 * 5.8 * 5
KP_INDEX = 0
LAST_KP_TIME = ""


@app.route('/', methods=['GET'])
def get_latest_data():
    global CACHE_TICKS, CACHE_DAILY_CCL_DATA, CACHE_CP_RATE_DATA, PAST_CCL_STABLE_DATA, KP_INDEX, LAST_KP_TIME
    # Check if the type is one of the allowed types
    
    start_time = time.time()
    results = {}
    zxj_infos = {}
    ccl_infos = {}
    list_size = 6
    data_types = ['rb', 'i', 'oi']
    # data_types = ['rb']
    # kp_time = date_utils.get_kp_time_string("2023-10-31")
    kp_time = date_utils.get_kp_time_string()
    is_working_day = date_utils.is_work_day(kp_time[:10])
    kp_info = {}
    current_str = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d')
    daily_ccl_datas = {}
    sum_infos = {}
    stable_ccl_datas = {}
    
            
    for data_type in data_types:
        
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(int(FIVE_DAYS_SIZE))
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
    app.run(debug=False, host='0.0.0.0', port=8080)
