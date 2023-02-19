import requests
import time
import math
import yaml
import socket
import click
import pytz

from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from datetime import datetime, timedelta
from pymongo import MongoClient, DESCENDING, ASCENDING

DATA_URL = "https://hq.sinajs.cn/list="
DATA_5M_URL = "http://stock2.finance.sina.com.cn/futures/api/json.php/IndexService.getInnerFuturesMiniKLine5m?symbol="
START_TIMES = [["085959", "101500"], ["103000", "113000"], ["133000", "150000"], ["205955", "240000"], ["000000", "013000"]]

def get_contract_map():
    max_date = constance.MAIN_COL.find_one({}, sort=[('date', DESCENDING)])['date']
    available_contracts = list(constance.MAIN_COL.find({"date": max_date, "kpl": {"$gt": 200000}}))
    types = {}
    
    for x in available_contracts:
        types[x['type']] = {}
        types[x['type']]['code'] = x['code']
        main_code = convert_code_to_standard_code(x['code'], x['type'])
        second_info = list(constance.INFO_COL.find({"date": max_date, "type": x['type'], "code": {"$gt": x['code']}}).sort("kpl", DESCENDING).limit(1))[0]
        second_code = convert_code_to_standard_code(second_info['code'], x['type'])
        types[x['type']]['norCode'] = main_code.upper()
        types[x['type']]['secondCode'] = second_code
        types[x['type']]['secondNorCode'] = second_code.upper()
    return types

def convert_code_to_standard_code(source_code, contract):
    code_date = source_code.replace(contract, "")
    month = code_date[-2:]
    year_p = code_date[:-2]
    year_p = "2" + year_p[-1]
    return contract + year_p + month

def get_current_data(types, code_key = "norCode", current_time = ""):
    normalised_codes = list(("nf_" + v[code_key]) for k, v in types.items())
    if current_time == "":
        current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.000')
    url = DATA_URL + ",".join(normalised_codes)
    r = requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'}, proxies=constance.PROXIES) if constance.ONLINE else requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'})
    # utils.log(r.text)
    # with open("/log.txt", "a") as f:
    #     f.write("{} \n".format(r.text))

    datas = []
    for line in r.text.split("\n"):
        data_array = line.split("=")
        if len(data_array) > 1:
            nor_code = data_array[0].replace("var hq_str_nf_", "")
            code = ""
            for k, v in types.items():
                if v[code_key] == nor_code:                    
                    code = v['secondCode'] if "second" in code_key else v['code']
                    t = k
                    break
                
            if code == "":
                continue

            data_str = data_array[1].replace("\"", "").replace(";", "")
            data = convert_str_to_ticker_data(current_time, t, code, data_str)
            datas.append(data)
    
    # with open("/data.txt", "a") as f:
    #     f.write("{} \n".format(datas))
    # echo_dics(datas, min_head_length=12)
    return datas,r.text

def is_end_with_5_sec():
    current_sec = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%S')[-1]
    return current_sec == "0" or current_sec == "5"

def collect_tick_data():
    # Contract map
    types = get_contract_map()
    cols = {}
    cols["norCode"] = constance.REAL_TIME_TICK_COL
    cols["secondNorCode"] = constance.REAL_TIME_TICK_SECOND_COL
    last_datas = {}
    for key_code in ["norCode", "secondNorCode"]:
        last_one = cols[key_code].find_one({}, sort=[("time", DESCENDING)])     
        last_datas[key_code] = list(cols[key_code].find({"time": last_one['time']})) if last_one != None else []    
    
    last_trade_status = False
    utils.log("Start collect realtime tick")
    # utils.log("Types {0}".format(types))
    while True:
        # align time
        while not is_end_with_5_sec():
            time.sleep(0.4)            
        
        current_trade_status = is_trading()
        if last_trade_status != current_trade_status:
            if not current_trade_status:
                types = get_contract_map()
            elif current_trade_status:
                current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.000')
                if current_time.split(" ")[1] >= "20:55:00.000":
                    for t, v in types.items():
                        utils.log("Type {0} code {1} secondCode {2}".format(t, v['code'], v['secondCode']))

            utils.log("Change trade status, current {0}".format("trading" if current_trade_status else "close"))
        if current_trade_status:
            current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.000')
            for code_key in ["norCode", "secondNorCode"]:
            # get main tick info 
                current_datas, raw_text = get_current_data(types, code_key=code_key, current_time=current_time)
                # click.echo(types)
                # click.echo(raw_text)
                for d in current_datas:
                    if d['cjl'] > 0 and d['ccl'] > 0:
                        if valid_data(d, last_datas[code_key]):
                            cols[code_key].insert_one(d)
                        else:
                            click.echo("error data {}".format(d))
                            click.echo("error raw text {}".format(raw_text))
                
                last_datas[code_key] = current_datas
                
            # Update sum_ccl for real time tick
            # "norCode", "secondNorCode"
            for t in cols["norCode"].find({"time": current_time}):
                sec_info = cols["secondNorCode"].find_one(
                    {'type': t['type'], 'time': {"$lte": t['time']}}, sort=[('time', -1)])
                if sec_info:
                    filter = {'type': t['type'], 'time': t['time']}
                    newvalues = {"$set": {'sum_ccl': t['ccl'] + sec_info['ccl']}}
                    cols["norCode"].update_one(filter, newvalues)
                else:
                    utils.log("No sec data {} {}".format(t['type'], t['time']))
                
        last_trade_status = current_trade_status
        time.sleep(4)

# tick {"time" : "20200526 140750", "type" : "ag", "code" : "ag2012", "jkp" : 4195, "zgj" : 4319, "zdj" : 4180, "zxj" : 4299, "ccl" : 482064, "cjl" : 872750 }
#tick5m{"time" : "20210127 094000", "type" : "cu", "code" : "cu2102", "kpj" : "58800.000", "zgj" : "58800.000", "zdj" : "58790.000", "spj" : "58790.000", "cjl" : "263" }
def valid_data(data, last_datas):
    correct_data = True
    if len(last_datas) > 0:
        for l in last_datas:
            # if zxj has big change， then use last one
            if data['type'] == l['type']:
                if data['code'] == l['code'] and abs(data['zxj'] - l['zxj']) / l['zxj'] > 0.08:
                    correct_data = False
                    data['zxj'] = l['zxj']
                data['cjlDiff'] = (data['cjl'] - l['cjl']) if data['cjl'] >= l['cjl'] else data['cjl']
                break    
    return correct_data

def is_trading():
    current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%H%M%S')
    today_str = date_utils.get_today_date_string()
    working = date_utils.is_work_day(today_str)
    if not working and current_time <= "013000":
        yesterdayday_str = date_utils.datestr_add_days(today_str, -1)       
        working = date_utils.is_work_day(yesterdayday_str)

    if working:
        for time_pair in START_TIMES:
            if current_time >= time_pair[0] and current_time <= time_pair[1]:
                return True
    
    return False

def convert_str_to_ticker_data(current_time, contract_type, code, data_str):
    str_s = data_str.split(",")
    data = {}
    data['time'] = ""
    data['type'] = contract_type
    data['code'] = code
    data['date'] = current_time.split(" ")[0]
    data['jkp'] = float(str_s[2]) if len(str_s) > 2 else 0
    data['zgj'] = float(str_s[3]) if len(str_s) > 3 else 0
    data['zdj'] = float(str_s[4]) if len(str_s) > 4 else 0
    data['zxj'] = float(str_s[8]) if len(str_s) > 8 else 0
    data['ccl'] = int(float(str_s[13])) if len(str_s) > 13 else 0
    data['cjl'] = int(float(str_s[14])) if len(str_s) > 14 else 0
    return data

def test_data():
    types = get_contract_map()
    utils.log("{}".format(types))
    for code_key in ["norCode", "secondNorCode"]:
        current_datas, raw_text = get_current_data(types, code_key)
        results = []
        for d in current_datas:
            if d['cjl'] > 0 and (d['cjl'] != types[d['type']]['cjl'] or d['ccl'] != types[d['type']]['ccl']):
                results.append(d)
    
        utils.log("{}".format(raw_text))
        utils.log("----------------------------------------")
        utils.log("{}".format(results))

@click.command()
@click.option('--collect-type', '-c', default="s", help='collect data time span 5s  s|m')
def collect_data(collect_type):
    if collect_type == "s":
        collect_tick_data()
    else:
        test_data()

if __name__ == "__main__":
    collect_data()
    # get_current_data({"rb": {"norCode":"RB2301"}})
 
