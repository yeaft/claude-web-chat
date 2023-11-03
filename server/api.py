from flask import Flask, request, render_template
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import v3_keep_doing
from datetime import datetime, timedelta
import time
from pymongo import MongoClient, DESCENDING, ASCENDING

app = Flask(__name__)

@app.route('/', methods=['GET'])
def get_latest_data():
    # Check if the type is one of the allowed types
    start_time = time.time()
    results = {}
    infos = {}
    list_size = 8
    data_types = ['rb', 'oi', 'i', 'y']
    kp_time = date_utils.get_kp_time_string("2023-11-01")
    
    for data_type in data_types:
        source_data = list(constance.REAL_TIME_TICK_COL.find({'type': data_type, 'time': {'$gte': kp_time}}).sort([('time', 1)]))
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
            
            titles =["Item", "Start", "Min", "Max", "Now", "S2Now"]
            price_info = ["ZXJ", f"{start_tick['zxj']}", f"{min_zxj_data['zxj']}({int(min_zxj_data['zxj'] - start_tick['zxj'])}/{start_to_min_duration}m)", f"{max_zxj_data['zxj']}({int(max_zxj_data['zxj'] - min_zxj_data['zxj'])}/{min_to_max_duration}m)", f"{source_data[-1]['zxj']}({int(source_data[-1]['zxj'] - max_zxj_data['zxj'])}/{max_to_current_duration}m)", f"{source_data[-1]['zxj']}({int(source_data[-1]['zxj'] - start_tick['zxj'])}/{start_to_current_duration}m)"]
            ccl_info = ["CCL", f"{start_tick['ccl']}", f"{min_zxj_data['ccl']}({int(min_zxj_data['ccl'] - start_tick['ccl'])})", f"{max_zxj_data['ccl']}({int(max_zxj_data['ccl'] - min_zxj_data['ccl'])})", f"{source_data[-1]['ccl']}({int(source_data[-1]['ccl'] - max_zxj_data['ccl'])})", f"{source_data[-1]['ccl']}({int(source_data[-1]['ccl'] - start_tick['ccl'])})"]
            price_ccl_power = ["C/P", "", f"{int((min_zxj_data['ccl'] - start_tick['ccl'])/(min_zxj_data['zxj'] - start_tick['zxj'])) if min_zxj_data['zxj'] - start_tick['zxj'] != 0 else 0}", f"{int((max_zxj_data['ccl'] - min_zxj_data['ccl'])/(max_zxj_data['zxj'] - min_zxj_data['zxj'])) if max_zxj_data['zxj'] - min_zxj_data['zxj'] != 0 else 0}", f"{int((source_data[-1]['ccl'] - max_zxj_data['ccl'])/(source_data[-1]['zxj'] - max_zxj_data['zxj'])) if source_data[-1]['zxj'] - max_zxj_data['zxj'] != 0 else 0}"]

        elif max_zxj_data['time'] < min_zxj_data['time']:
            start_to_max_duration = date_utils.min_diff(start_tick['time'], max_zxj_data['time'])
            max_to_min_duration = date_utils.min_diff(max_zxj_data['time'], min_zxj_data['time'])
            min_to_current_duration = date_utils.min_diff(min_zxj_data['time'], source_data[-1]['time'])
            
            titles = ["Item", "Start", "Max", "Min", "Current"]
            price_info = ["ZXJ", f"{start_tick['zxj']}", f"{max_zxj_data['zxj']}({int(max_zxj_data['zxj'] - start_tick['zxj'])}/{start_to_max_duration}m)", f"{min_zxj_data['zxj']}({int(min_zxj_data['zxj'] - max_zxj_data['zxj'])}/{max_to_min_duration}m)", f"{source_data[-1]['zxj']}({int(source_data[-1]['zxj'] - min_zxj_data['zxj'])}/{min_to_current_duration}m)"]
            ccl_info = ["CCL", f"{start_tick['ccl']}", f"{max_zxj_data['ccl']}({int(max_zxj_data['ccl'] - start_tick['ccl'])})", f"{min_zxj_data['ccl']}({int(min_zxj_data['ccl'] - max_zxj_data['ccl'])})", f"{source_data[-1]['ccl']}({int(source_data[-1]['ccl'] - min_zxj_data['ccl'])})"]
            price_ccl_power = ["C/P", "", f"{int((max_zxj_data['ccl'] - start_tick['ccl'])/(max_zxj_data['zxj'] - start_tick['zxj'])) if max_zxj_data['zxj'] - start_tick['zxj'] != 0 else 0}", f"{int((min_zxj_data['ccl'] - max_zxj_data['ccl'])/(min_zxj_data['zxj'] - max_zxj_data['zxj'])) if min_zxj_data['zxj'] - max_zxj_data['zxj'] != 0 else 0}", f"{int((source_data[-1]['ccl'] - min_zxj_data['ccl'])/(source_data[-1]['zxj'] - min_zxj_data['zxj'])) if source_data[-1]['zxj'] - min_zxj_data['zxj'] != 0 else 0}"]
            # price_info = f"ZXJ: {start_tick['zxj']} - {max_zxj_data['zxj']}({int(max_zxj_data['zxj'] - start_tick['zxj'])}/{start_to_max_duration}m) - {min_zxj_data['zxj']}({int(min_zxj_data['zxj'] - max_zxj_data['zxj'])}/{max_to_min_duration}m) - {source_data[-1]['zxj']}({int(source_data[-1]['zxj'] - min_zxj_data['zxj'])}/{min_to_current_duration}m)"
            # ccl_info = f"CCL: {start_tick['ccl']} - {max_zxj_data['ccl']}({int(max_zxj_data['ccl'] - start_tick['ccl'])}) - {min_zxj_data['ccl']}({int(min_zxj_data['ccl'] - max_zxj_data['ccl'])}) - {source_data[-1]['ccl']}({int(source_data[-1]['ccl'] - min_zxj_data['ccl'])})"
            # price_ccl_power = f"C/P: {int((max_zxj_data['ccl'] - start_tick['ccl'])/(max_zxj_data['zxj'] - start_tick['zxj'])) if max_zxj_data['zxj'] - start_tick['zxj'] != 0 else 0} - {int((min_zxj_data['ccl'] - max_zxj_data['ccl'])/(min_zxj_data['zxj'] - max_zxj_data['zxj'])) if min_zxj_data['zxj'] - max_zxj_data['zxj'] != 0 else 0} - {int((source_data[-1]['ccl'] - min_zxj_data['ccl'])/(source_data[-1]['zxj'] - min_zxj_data['zxj'])) if source_data[-1]['zxj'] - min_zxj_data['zxj'] != 0 else 0}"
            
        infos[data_type] = [
            titles, price_info, ccl_info, price_ccl_power
        ]
            
        if len(source_data) > list_size:
            data = source_data[-list_size:]
        else:
            data = list(constance.REAL_TIME_TICK_COL.find({'type': data_type}).sort([('time', -1)]).limit(list_size))
            
        if data:
            sorted_data = sorted(data, key=lambda x: x['time'])
            result = []
            for i in range(1, len(sorted_data)):
                record = sorted_data[i]
                result.append(
                    {
                        "time": record['time'].split(" ")[-1],
                        "code": record['code'],
                        "zxj": record['zxj'] if data_type == 'i' else int(record['zxj']),
                        "cjl": int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']),
                        "zjl": sorted_data[i]['ccl'] - sorted_data[i - 1]['ccl'],
                        "zjl-kp": int(record['ccl'] - start_tick['ccl']) if start_tick else int(record['ccl']),                        
                    }
                )
            
            results[data_type] = result
    
    processing_time = int((time.time() - start_time) * 1000)  # in milliseconds
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    if results:        
        return render_template('data.html', infos=infos, data=results, processing_time=processing_time, openning_time=kp_time, current_time=current_time)
    else:
        return "No data found for the given type", 404

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=8080)
