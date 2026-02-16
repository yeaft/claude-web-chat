from flask import Flask, request, render_template
from helper import constance, date_utils, utils
import time
from statistics import mean
from flask_compress import Compress
import random

from server.common import (
    CACHE_TICKS, CACHE_TICKS_1MIN, TEN_DAYS_SIZE,
    FIVE_DAYS_MINS_SIZE, KP_TICKS, DATA_TYPES, EXTREME_SET,
    block_ip, requires_auth, aggregate_ticks_to_1min,
)

app = Flask(__name__)
Compress(app)

CANDIDATE_CODES = ["rb2510"]

CONTEXT = {
    "default_code": "rb2510"
}


def initial_ticks():
    for data_type in DATA_TYPES:
        if data_type not in CACHE_TICKS:
            if data_type not in EXTREME_SET:
                EXTREME_SET[data_type] = {'ccl': [], 'zxj': [], 'cjlDiff': []}
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(TEN_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks
            CACHE_TICKS_1MIN[data_type] = aggregate_ticks_to_1min(sorted_ticks, data_type)

    utils.log("Finish inital real ticks data")
    utils.log("Start to initial training data")
    for code in CANDIDATE_CODES:
        if code not in CONTEXT:
            ticks = list(constance.REAL_TIME_TICK_COL.find({"code": code}).sort([("time", 1)]))
            data_type_for_code = "i" if "i" in code else code[:2]
            m_ticks = aggregate_ticks_to_1min(ticks, data_type_for_code)

            train_status = constance.TRAIN_COL.find_one({"code": code})
            if train_status is None:
                tick_index = TEN_DAYS_SIZE
                min_index = 0
            else:
                tick_index = train_status['index']
                min_index = train_status['min_index']

            CONTEXT[code] = {
                "index": tick_index,
                "ticks": ticks,
                "min_index": min_index,
                "min_ticks": m_ticks
            }

            print(f"Finish inital ticks data for {code}, total ticks: {len(ticks)}, total min ticks: {len(m_ticks)}")

    utils.log("Finish inital train ticks data")


def save_train_status(code):
    constance.TRAIN_COL.update_one(
        {"code": code},
        {"$set": {"index": CONTEXT[code]['index'], "min_index": CONTEXT[code]['min_index']}},
        upsert=True
    )


# ==================== Real-time Data Routes ====================

@app.route('/ticks', methods=['GET'])
@block_ip()
def get_latest_1min_ticks():
    data = {}
    for data_type in DATA_TYPES:
        if len(CACHE_TICKS_1MIN[data_type]) >= TEN_DAYS_SIZE:
            CACHE_TICKS_1MIN[data_type] = CACHE_TICKS_1MIN[data_type][-TEN_DAYS_SIZE:]
        last_tick = CACHE_TICKS_1MIN[data_type][-1]
        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gt": last_tick["time"] + ".000"}}).sort("time", 1))
        is_updated = False
        if len(new_ticks) >= 10:
            m_ticks = aggregate_ticks_to_1min(new_ticks, data_type)
            CACHE_TICKS_1MIN[data_type] = CACHE_TICKS_1MIN[data_type][len(m_ticks):]
            CACHE_TICKS_1MIN[data_type].extend(m_ticks)
            is_updated = bool(m_ticks)

        data[data_type] = list(CACHE_TICKS_1MIN[data_type])
        if not is_updated and len(new_ticks) > 0 and new_ticks[-1] != last_tick:
            zxjs = [x['zxj'] for x in new_ticks]
            ccls = [x['ccl'] for x in new_ticks]
            min_zxj = min(zxjs)
            avg_ccl = mean(ccls)
            max_zxj = max(zxjs)
            cjl = sum(x['cjlDiff'] for x in new_ticks)
            new_time = date_utils.min_add(new_ticks[-1]['time'], 1)
            data[data_type].append({
                "time": new_time[:-4],
                "code": new_ticks[-1]['code'],
                "max_zxj": int(max_zxj) if data_type != "i" else round(max_zxj * 2) / 2,
                "min_zxj": int(min_zxj) if data_type != "i" else round(min_zxj * 2) / 2,
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
    start_time = time.time()
    list_size = 26
    kp_time = date_utils.get_kp_time_string()
    is_working_day = date_utils.is_work_day(kp_time[:10])
    result = {}

    for data_type in DATA_TYPES:
        result[data_type] = {}
        if data_type not in CACHE_TICKS:
            ticks = constance.REAL_TIME_TICK_COL.find({"type": data_type}).sort([("time", -1)]).limit(TEN_DAYS_SIZE)
            sorted_ticks = sorted(ticks, key=lambda x: x['time'])
            CACHE_TICKS[data_type] = sorted_ticks

        if len(CACHE_TICKS[data_type]) >= 1.2 * TEN_DAYS_SIZE:
            CACHE_TICKS[data_type] = CACHE_TICKS[data_type][-TEN_DAYS_SIZE:]

        new_ticks = list(constance.REAL_TIME_TICK_COL.find({"type": data_type, "time": {"$gt": CACHE_TICKS[data_type][-1]['time']}}).sort([("time", 1)]))
        if new_ticks:
            CACHE_TICKS[data_type] += new_ticks

        if is_working_day or data_type not in KP_TICKS:
            if data_type not in KP_TICKS or kp_time != KP_TICKS[data_type]['time']:
                utils.log("kp_time: {}".format(kp_time))
                KP_TICKS[data_type] = constance.REAL_TIME_TICK_COL.find_one({"type": data_type, "time": {"$lte": kp_time}}, sort=[("time", -1)])

        result[data_type]['kp_info'] = [[CACHE_TICKS[data_type][-1]['code'],
            CACHE_TICKS[data_type][-1]['zxj'],
            CACHE_TICKS[data_type][-1]['ccl'],
            int(CACHE_TICKS[data_type][-1]['zxj'] - KP_TICKS[data_type]['zxj']) if data_type != 'i' else round((CACHE_TICKS[data_type][-1]['zxj'] - KP_TICKS[data_type]['zxj']) * 2) / 2,
            int(CACHE_TICKS[data_type][-1]['ccl'] - KP_TICKS[data_type]['ccl'])]]

        data = CACHE_TICKS[data_type][-list_size:]
        latest_ticks = []
        for i in range(1, len(data)):
            record = data[i]
            latest_ticks.append(
                [record['time'][11:-4], record['zxj'] if data_type == 'i' else int(record['zxj']), int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']), int(data[i]['ccl'] - data[i - 1]['ccl']), int(record['ccl'])]
            )

        result[data_type]['ticks'] = latest_ticks

        ccl_sums = []
        for i in range(10, 0, -1):
            start_index = - i * 12
            end_index = - (i - 1) * 12 if i != 1 else len(CACHE_TICKS[data_type])
            ccl_sums.append(sum(tick['cjlDiff'] for tick in CACHE_TICKS[data_type][start_index:end_index]))

        result[data_type]['ccl_sums'] = [ccl_sums[:5], ccl_sums[5:]]

    processing_time = int((time.time() - start_time) * 1000)
    utils.log("processing_time: {}".format(processing_time))
    return result


# ==================== Training Routes ====================

@app.route('/t')
@block_ip()
@requires_auth
def train():
    return render_template('train.html')


@app.route('/t/d', methods=['GET'])
@block_ip()
def get_train_info():
    start_time = time.time()
    list_size = 65
    next_count = request.args.get('next', default=1, type=int)
    code = request.args.get('code', default=CONTEXT["default_code"], type=str)
    is_random = request.args.get('random', default=False, type=bool)
    CONTEXT["default_code"] = code

    if "rb" in code:
        data_type = "rb"
    elif "i" in code:
        data_type = "i"
    elif "hc" in code:
        data_type = "hc"
    else:
        return {"error": "Invalid code"}

    result = {data_type: {}}

    if is_random:
        CONTEXT[code]["index"] = random.randint(TEN_DAYS_SIZE, len(CONTEXT[code]["ticks"]) - TEN_DAYS_SIZE)
        CONTEXT[code]["min_index"] = int(CONTEXT[code]["index"] / 12 - 500)

    next_index = CONTEXT[code]["index"] + next_count
    CONTEXT[code]["index"] = next_index
    data = CONTEXT[code]["ticks"][next_index - list_size:next_index]
    latest_ticks = []
    for i in range(1, len(data)):
        record = data[i]
        latest_ticks.append(
            [record['time'][11:-4], record['zxj'] if data_type == 'i' else int(record['zxj']), int(record['cjlDiff'] if "cjlDiff" in record else record['cjl']), int(data[i]['ccl'] - data[i - 1]['ccl']), int(record['ccl'])]
        )

    result[data_type]['ticks'] = latest_ticks[-24:]

    ccl_sums = []
    for i in range(5, 0, -1):
        start_index = - i * 12
        end_index = - (i - 1) * 12 if i != 1 else len(data)
        ccl_sums.append(sum(tick['cjlDiff'] for tick in data[start_index:end_index]))

    result[data_type]['ccl_sums'] = [ccl_sums]

    # Find end_index for chart_ticks
    last_index = CONTEXT[code]["min_index"]
    end_tick = data[-1]
    while CONTEXT[code]['min_ticks'][last_index]['time'] > end_tick['time'][:-4]:
        last_index -= 5
        if last_index <= 0:
            break

    end_index = -1
    for i in range(last_index, len(CONTEXT[code]['min_ticks'])):
        if CONTEXT[code]['min_ticks'][i]['time'][:-2] == end_tick['time'][:-6]:
            end_index = i + 1
            break

    if end_index == -1:
        print(f"Cannot find end_index for {CONTEXT[code]['min_ticks'][last_index + 1]['time']} {end_tick['time'][:-4]}")
    else:
        chart_start = max(0, end_index - FIVE_DAYS_MINS_SIZE)
        result[data_type]['chart_ticks'] = CONTEXT[code]["min_ticks"][chart_start:end_index]
        CONTEXT[code]["min_index"] = end_index - 1

        start_tick_time = CONTEXT[code]['min_ticks'][end_index - 1]['time'][:-2] + "05.000"
        start_min_index = -1
        for i in range(len(data)):
            if data[i]['time'] >= start_tick_time:
                start_min_index = i
                break

        if start_min_index > -1:
            sub_ticks = data[start_min_index:]
            if len(sub_ticks) > 0:
                zxjs = [x['zxj'] for x in sub_ticks]
                ccls = [x['ccl'] for x in sub_ticks]
                min_zxj = min(zxjs)
                avg_ccl = mean(ccls)
                max_zxj = max(zxjs)
                cjl = sum(x['cjlDiff'] for x in sub_ticks)
                new_time = date_utils.min_add(sub_ticks[-1]['time'], 1)
                result[data_type]['chart_ticks'].append({
                    "time": new_time[:-4],
                    "code": sub_ticks[-1]['code'],
                    "max_zxj": int(max_zxj) if data_type != "i" else round(max_zxj * 2) / 2,
                    "min_zxj": int(min_zxj) if data_type != "i" else round(min_zxj * 2) / 2,
                    "ccl": int(avg_ccl),
                    "cjl": int(cjl),
                })

    save_train_status(code)
    print(f"Finish get_info in {round((time.time() - start_time) * 1000, 2)}ms")
    return result


@app.route('/t/o', methods=['GET'])
@block_ip()
def record_operate():
    operation = request.args.get('operation', default="", type=str)
    code = CONTEXT["default_code"]
    tick_now = CONTEXT[code]["ticks"][CONTEXT[code]["index"]]
    operation_info = {
        "train_time": date_utils.get_today_time_string(),
        "operation": operation,
        "code": code,
        "time": tick_now['time'],
        "zxj": tick_now['zxj'],
    }
    constance.TRAIN_OPT_COL.insert_one(operation_info)
    return {"status": "success", "operation": operation, "time": tick_now['time']}


if __name__ == '__main__':
    initial_ticks()
    app.run(debug=False, host='0.0.0.0', port=8080)
