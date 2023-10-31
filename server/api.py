from flask import Flask, request, render_template
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import v3_keep_doing
from datetime import datetime, timedelta
from pymongo import MongoClient, DESCENDING, ASCENDING

app = Flask(__name__)

@app.route('/', methods=['GET'])
def get_latest_data():
    data_type = request.args.get('type')  # Get 'type' parameter from the query

    # Check if the type is one of the allowed types
    if data_type not in ['rb', 'oi']:
        data_type = "rb"
    
    # Query the latest data based on the 'type'
    data = list(constance.REAL_TIME_TICK_COL.find({'type': data_type}).sort([('time', -1)]).limit(12) )
    results = []
    for d in data:
        results.append(
            {
                "time": d['time'],
                "code": d['code'],
                "zxj": d['zxj'],
                "cjl": d['cjlDiff'] if "cjlDiff" in d else d['cjl'],
                "ccl": d['ccl']
            }
        )
    if results:
        sorted_results = sorted(results, key=lambda x: x['time'])
        return render_template('data.html', data=list(sorted_results))
    else:
        return "No data found for the given type", 404

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=8080)