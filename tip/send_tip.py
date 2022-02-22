import requests
import time
import math
import yaml
import socket
import click

from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from datetime import datetime, timedelta
from pymongo import MongoClient, DESCENDING, ASCENDING

def send_tips(types, ):
    # align time
    while True:
        current_sec = datetime.now().strftime('%S')
        if current_sec >= "30":
            break
        time.sleep(5)
    types = get_types()
    current_datas, raw_text = get_current_data(types)
    # current_datas = []
    # data = {}
    # data['type'] = "ru"
    # data['code'] = "ru2009"
    # data['jkp'] = 10255
    # data['zgj'] = 10280
    # data['zdj'] = 10080
    # data['zxj'] = 10140
    # current_datas.append(data)
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
