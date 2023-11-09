from flask import Flask, request, render_template
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import v3_keep_doing
from datetime import datetime, timedelta
import time
from pymongo import MongoClient, DESCENDING, ASCENDING

app = Flask(__name__)

global CACHE_TICKS, CACHE_DAILY_CCL_DATA, CACHE_CP_RATE_DATA, PAST_CCL_STABLE_DATA, KP_INDEX, LAST_KP_TIME
CACHE_TICKS = {}
CACHE_DAILY_CCL_DATA = {}
CACHE_CP_RATE_DATA = {}
PAST_CCL_STABLE_DATA = {}
FIVE_DAYS_SIZE = 12 * 60 * 5.5 * 5
KP_INDEX = 0
LAST_KP_TIME = ""


@app.route('/', methods=['GET'])
def get_latest_data():
    global CACHE_TICKS, CACHE_DAILY_CCL_DATA, CACHE_CP_RATE_DATA, PAST_CCL_STABLE_DATA, KP_INDEX, LAST_KP_TIME
    # Check if the type is one of the allowed types
    
    start_time = time.time()
    results = {}
    infos = {}
    list_size = 6
    data_types = ['rb', 'i', 'oi']
    # data_types = ['rb']
    kp_time = date_utils.get_kp_time_string()
    current_str = datetime.now().strftime('%Y-%m-%d')
    daily_ccl_datas = {}
    cp_infos = {}
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
            CACHE_DAILY_CCL_DATA[data_type] = analysis_helper.get_past_n_days_ccl_min_max(data_type, 4)
            # utils.log("CACHE_DAILY_CCL_DATA: {}".format(CACHE_DAILY_CCL_DATA[data_type]))

        daily_ccl_datas[data_type] = []
        for k, v in CACHE_DAILY_CCL_DATA[data_type].items():
            if k != current_str:
                daily_ccl_datas[data_type].append({
                    "date": k,
                    "start": v["start"],
                    "close_d": v["close_diff"],
                    "min": v["min"],
                    "max": v["max"],
                    "mm_c": v["minmax_diff"]           
                })
        
        # Get CP rate
        if data_type not in CACHE_CP_RATE_DATA or current_str not in CACHE_CP_RATE_DATA[data_type]:
            CACHE_CP_RATE_DATA[data_type] = {}
            CACHE_CP_RATE_DATA[data_type][current_str] = analysis_helper.get_cp_rate_by_exrema_price(CACHE_TICKS[data_type])
            # utils.log("CACHE_CP_RATE_DATA: {}".format(CACHE_CP_RATE_DATA[data_type]))

        cp_infos[data_type] = ""
        for cp_rate in CACHE_CP_RATE_DATA[data_type][current_str]:
            cp_infos[data_type] += f"{cp_rate['rate_type']}: {cp_rate['cp_avg']},{cp_rate['cp_std']},{cp_rate['count']} | "
        
        cp_infos[data_type] = cp_infos[data_type][:-3]
                            
        # source_data = list(constance.REAL_TIME_TICK_COL.find({'type': data_type, 'time': {'$gte': kp_time}}).sort([('time', 1)]))       
        
        if data_type not in PAST_CCL_STABLE_DATA or "00:00.000" in CACHE_TICKS[data_type][-1]['time'] :
            PAST_CCL_STABLE_DATA[data_type] = analysis_helper.get_stable_ccl_time(CACHE_TICKS[data_type])
        
        stable_ccl_datas[data_type] = [[],[],[],[]]
        for i in range(-min(6, len(PAST_CCL_STABLE_DATA[data_type])), 0):
            stable_ccl = PAST_CCL_STABLE_DATA[data_type][i]
            last_stable_ccl = PAST_CCL_STABLE_DATA[data_type][i - 1]
            stable_ccl_datas[data_type][0].append(stable_ccl['end_time'][11:-4])
            stable_ccl_datas[data_type][1].append(stable_ccl['avg_zxj'])
            stable_ccl_datas[data_type][2].append(stable_ccl['avg_ccl'])
            stable_ccl_datas[data_type][3].append(f"{stable_ccl['avg_ccl'] - last_stable_ccl['avg_ccl']}/{int(stable_ccl['avg_zxj'] - last_stable_ccl['avg_zxj'])}")
            
        if kp_time != LAST_KP_TIME:
            index_diff = min(int(date_utils.sec_diff(kp_time, CACHE_TICKS[data_type][-1]['time']) / 5) + 12 * 60 * 3, len(CACHE_TICKS[data_type]))
            utils.log(f"{date_utils.sec_diff(kp_time, CACHE_TICKS[data_type][-1]['time']) / 5} {index_diff}")
            kp_index = len(CACHE_TICKS[data_type]) - 12 * 60 * 4
            for i in range(len(CACHE_TICKS[data_type]) - 12 * 60 * 4, index_diff):
                if CACHE_TICKS[data_type][i]['time'] <= kp_time:
                    kp_index = i
                    break
            LAST_KP_TIME = kp_time
            KP_INDEX = kp_index
        
        source_data = CACHE_TICKS[data_type][KP_INDEX:]
        start_tick = None
        for d in source_data:
            if d['cjl'] > 0:
                start_tick = d
                break
        
        max_zxj_data = max(source_data, key=lambda x: x['zxj'])
        min_zxj_data = min(source_data, key=lambda x: x['zxj'])        
        
        if max_zxj_data['time'] > min_zxj_data['time']:            
            start_to_min_duration = date_utils.min_diff(start_tick['time'], min_zxj_data['time'])
            min_to_max_duration = date_utils.min_diff(min_zxj_data['time'], max_zxj_data['time'])
            max_to_current_duration = date_utils.min_diff(max_zxj_data['time'], source_data[-1]['time'])
            start_to_current_duration = date_utils.min_diff(start_tick['time'], source_data[-1]['time'])
            
            titles =["Item", f"Start", f"Min {start_to_min_duration}m", f"Max {min_to_max_duration}m", f"Now {max_to_current_duration}m", f"S2Now {start_to_current_duration}m"]
            price_info = ["ZXJ", f"{start_tick['zxj']}", f"{min_zxj_data['zxj']}", f"{max_zxj_data['zxj']}", f"{source_data[-1]['zxj']}", f"{source_data[-1]['zxj']}"]
            ccl_info = ["CCL", f"{start_tick['ccl']}", f"{min_zxj_data['ccl']}", f"{max_zxj_data['ccl']}", f"{source_data[-1]['ccl']}", f"{source_data[-1]['ccl'] - start_tick['ccl']}"]
            # price_ccl_power = ["C/P", "", f"{int((min_zxj_data['ccl'] - start_tick['ccl'])/(min_zxj_data['zxj'] - start_tick['zxj'])) if min_zxj_data['zxj'] - start_tick['zxj'] != 0 else 0}", f"{int((max_zxj_data['ccl'] - min_zxj_data['ccl'])/(max_zxj_data['zxj'] - min_zxj_data['zxj'])) if max_zxj_data['zxj'] - min_zxj_data['zxj'] != 0 else 0}", f"{int((source_data[-1]['ccl'] - max_zxj_data['ccl'])/(source_data[-1]['zxj'] - max_zxj_data['zxj'])) if source_data[-1]['zxj'] - max_zxj_data['zxj'] != 0 else 0}"]

        elif max_zxj_data['time'] < min_zxj_data['time']:
            start_to_max_duration = date_utils.min_diff(start_tick['time'], max_zxj_data['time'])
            max_to_min_duration = date_utils.min_diff(max_zxj_data['time'], min_zxj_data['time'])
            min_to_current_duration = date_utils.min_diff(min_zxj_data['time'], source_data[-1]['time'])
            start_to_current_duration = date_utils.min_diff(start_tick['time'], source_data[-1]['time'])
            
            titles = ["Item", f"Start", f"Max {start_to_max_duration}m", f"Min {max_to_min_duration}m", f"Now {min_to_current_duration}m", f"S2Now {start_to_current_duration}m"]
            price_info = ["ZXJ", f"{start_tick['zxj']}", f"{max_zxj_data['zxj']}", f"{min_zxj_data['zxj']}", f"{source_data[-1]['zxj']}", f"{source_data[-1]['zxj']}"]
            ccl_info = ["CCL", f"{start_tick['ccl']}", f"{max_zxj_data['ccl']}", f"{min_zxj_data['ccl']}", f"{source_data[-1]['ccl']}", f"{source_data[-1]['ccl'] - start_tick['ccl']}"]
            # price_ccl_power = ["C/P", "", f"{int((max_zxj_data['ccl'] - start_tick['ccl'])/(max_zxj_data['zxj'] - start_tick['zxj'])) if max_zxj_data['zxj'] - start_tick['zxj'] != 0 else 0}", f"{int((min_zxj_data['ccl'] - max_zxj_data['ccl'])/(min_zxj_data['zxj'] - max_zxj_data['zxj'])) if min_zxj_data['zxj'] - max_zxj_data['zxj'] != 0 else 0}", f"{int((source_data[-1]['ccl'] - min_zxj_data['ccl'])/(source_data[-1]['zxj'] - min_zxj_data['zxj'])) if source_data[-1]['zxj'] - min_zxj_data['zxj'] != 0 else 0}"]
            # price_info = f"ZXJ: {start_tick['zxj']} - {max_zxj_data['zxj']}({int(max_zxj_data['zxj'] - start_tick['zxj'])}/{start_to_max_duration}m) - {min_zxj_data['zxj']}({int(min_zxj_data['zxj'] - max_zxj_data['zxj'])}/{max_to_min_duration}m) - {source_data[-1]['zxj']}({int(source_data[-1]['zxj'] - min_zxj_data['zxj'])}/{min_to_current_duration}m)"
            # ccl_info = f"CCL: {start_tick['ccl']} - {max_zxj_data['ccl']}({int(max_zxj_data['ccl'] - start_tick['ccl'])}) - {min_zxj_data['ccl']}({int(min_zxj_data['ccl'] - max_zxj_data['ccl'])}) - {source_data[-1]['ccl']}({int(source_data[-1]['ccl'] - min_zxj_data['ccl'])})"
            # price_ccl_power = f"C/P: {int((max_zxj_data['ccl'] - start_tick['ccl'])/(max_zxj_data['zxj'] - start_tick['zxj'])) if max_zxj_data['zxj'] - start_tick['zxj'] != 0 else 0} - {int((min_zxj_data['ccl'] - max_zxj_data['ccl'])/(min_zxj_data['zxj'] - max_zxj_data['zxj'])) if min_zxj_data['zxj'] - max_zxj_data['zxj'] != 0 else 0} - {int((source_data[-1]['ccl'] - min_zxj_data['ccl'])/(source_data[-1]['zxj'] - min_zxj_data['zxj'])) if source_data[-1]['zxj'] - min_zxj_data['zxj'] != 0 else 0}"
            
        infos[data_type] = [
            titles, price_info, ccl_info
        ]
            
        
            
        data = CACHE_TICKS[data_type][-list_size:]
        result = []
        for i in range(1, len(data)):
            record = data[i]
            result.append(
                {
                    "time": record['time'].split(" ")[-1],
                    "code": record['code'],
                    "zxj": record['zxj'] if data_type == 'i' else int(record['zxj']),
                    "cjl": int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']),
                    "zjl": int(data[i]['ccl'] - data[i - 1]['ccl']),
                    "ccl": int(record['ccl']),
                }
            )
        
        results[data_type] = result
        
    
    processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    if results:        
        return render_template('data.html', daily_ccl_datas= daily_ccl_datas, cp_infos =cp_infos, stable_ccl_datas= stable_ccl_datas, infos=infos, data=results, processing_time=processing_time, openning_time=kp_time[5:-4], current_time=current_time[5:-4])
    else:
        return "No data found for the given type", 404

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=8080)
