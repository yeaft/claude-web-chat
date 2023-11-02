from flask import Flask, request, render_template
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import v3_keep_doing
from datetime import datetime, timedelta
from pymongo import MongoClient, DESCENDING, ASCENDING

app = Flask(__name__)

@app.route('/', methods=['GET'])
def get_latest_data():
    # Check if the type is one of the allowed types
    results = {}
    data_types = ['rb', 'oi', 'i', 'y']
    for data_type in data_types:
        data = list(constance.REAL_TIME_TICK_COL.find({'type': data_type}).sort([('time', -1)]).limit(9))        
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
                        "ccl": int(record['ccl']),
                        
                    }
                )
            
            results[data_type] = result
    
    if results:        
        return render_template('data.html', data=results)
    else:
        return "No data found for the given type", 404

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=8080)
