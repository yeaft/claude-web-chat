import time
import pytz

from helper import date_utils, analysis_helper, utils
from collection.realtime_tick import get_current_data
from datetime import datetime


def send_tips(types):
    # align time
    while True:
        current_sec = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%S')
        if current_sec >= "30":
            break
        time.sleep(5)
    current_datas, raw_text = get_current_data(types)
    results = []
    for data in current_datas:
        results.extend(analysis_helper.mock_similars(data['type'], data['code'], date_utils.get_today_date_string(), data['jkp'], data['zgj'], data['zdj'], data['zxj']))
    
    msg = ""
    for res in results:
        msg += res['code'] + "," + res['direction'] + "," + str(res['trade1'].split(",")[0]) + "," + str(res['jsp']) + "," + str(res['cut']) + "\n"
        msg += "Info1: " + res['trade1'] + "\n"
        if res['trade2'] != "None":
            msg += "Info2: " + res['trade2'] + "\n"
        if res['trade3'] != "None":
            msg += "Info3: " + res['trade3'] + "\n"
        msg += "\n"

    utils.send_ding_msg(msg)
