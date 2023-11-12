import math
import click
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from statistics import mean, variance, stdev
import datetime, time

def find_history(ticks, value, column='ccl', similar_count = 3):
    i, j = 0, 0
    similar_ticks = []
    if column == "ccl":
        ccl_error = int(100000 / (ticks[-1]['zxj'] * 1.25)) + 1
    else:
        ccl_error = 0
    while j < similar_count and i < len(ticks):
        if ticks[i][column] <= value + ccl_error and ticks[i][column] >= value - ccl_error:
            similar_ticks.append(ticks[i])
            j += 1
            if column == "ccl":
                i += 12 * 30
            elif column == "zxj":
                i += 12 * 30
            else:
                i += 1
        else:
            i += 1
    
    return similar_ticks

def find_extrema(ticks, window=720, column='ccl'):
    extremas = []
    n = len(ticks)

    for i in range(0, n):
        ticks[i]['index'] = i
        if i < window:
            continue
        
        current_ccl = ticks[i][column]
        left_window = ticks[max(0, i-window):i]
        right_window = ticks[i+1:min(n, i+1+window)]

        max_left = max(left_window, key=lambda x: x[column], default={column: -float('inf')})[column]
        min_left = min(left_window, key=lambda x: x[column], default={column: float('inf')})[column]
        max_right = max(right_window, key=lambda x: x[column], default={column: -float('inf')})[column]
        min_right = min(right_window, key=lambda x: x[column], default={column: float('inf')})[column]

        if current_ccl >= max_left and current_ccl >= max_right:
            ticks[i]['extrema'] = f'{column}_highest'
            ticks[i]['index'] = i
            if extremas and extremas[-1]['extrema'] == f'{column}_highest':
                if extremas[-1][column] < ticks[i][column]:
                    extremas[-1] = ticks[i]
            else:
                extremas.append(ticks[i])
        elif current_ccl <= min_left and current_ccl <= min_right:
            ticks[i]['extrema'] = f'{column}_lowest'
            ticks[i]['index'] = i
            if extremas and extremas[-1]['extrema'] == f'{column}_lowest':
                if extremas[-1][column] > ticks[i][column]:
                    extremas[-1] = ticks[i]
            else:
                extremas.append(ticks[i])

        
    # for e in extremas:
    #     utils.log(f"{e['time']} {e['extrema']} {e['ccl']} {e['zxj']}")
    return extremas

def get_continuous_status(ticks, column="ccl", time_span = 12 * 5, avg_span = 12):
    start_index = (len(ticks)-avg_span) % time_span
    if start_index < avg_span:
        start_index += time_span
    datas = []
    for i in range(start_index, len(ticks) - avg_span, time_span):
        next_index = i + time_span
        mean_ccl = mean(t['ccl'] for t in ticks[i-avg_span:i+avg_span])
        mean_zxj = mean(t['zxj'] for t in ticks[i-avg_span:i+avg_span])
        mean_next_ccl = mean(t['ccl'] for t in ticks[next_index-avg_span:next_index+avg_span])
        mean_next_zxj = mean(t['zxj'] for t in ticks[next_index-avg_span:next_index+avg_span])
        
        mean_zxj_diff = int(mean_next_zxj - mean_zxj) if ticks[0]['type'] != "i" else round((mean_next_zxj - mean_zxj)*2)/2
        mean_ccl_diff = int(mean_next_ccl - mean_ccl)
        ccl_price_rate = int(mean_ccl_diff / mean_zxj_diff if mean_zxj_diff != 0 else mean_ccl_diff)
        data = {
            'time_range': f"{ticks[i]['time']}-{ticks[next_index]['time']}",
            'start_time': ticks[i]['time'],
            'start_index': i,
            'end_time': ticks[next_index]['time'],
            'end_index': next_index,
            'zxj_diff': mean_zxj_diff,
            'zxj_diff_rate': round(mean_zxj_diff * 1000 / ticks[i]['zxj'], 2),
            'ccl_diff': mean_ccl_diff,
            'ccl_diff_rate': round(mean_ccl_diff * 10000 / ticks[i]['ccl'],2),
            'cp_rate': ccl_price_rate
        }
        # utils.log(f"{data['time_range']} {data['zxj_diff']} {data['zxj_diff_rate']}‰ {data['ccl_diff']} {data['ccl_diff_rate']}%% {data['cp_rate']}")
        datas.append(data)
    
    return datas

from statistics import mean

from statistics import mean

def find_stable_sublists(ticks, data, by="ccl"):
    n = len(data)
    valid_sublists = []

    start = 0
    while start < n:
        sum_ccl = 0
        sum_zxj = 0
        size = 0
        last_valid_end = -1  # Track the last valid end index

        # Expand the window
        for end in range(start, n):
            sum_ccl += data[end]['ccl_diff_rate']
            sum_zxj += data[end]['zxj_diff_rate']
            size += 1

            if by == "ccl":
                # Check if the current window satisfies the conditions
                if size >= 3 and (abs(sum_ccl) <= 3 or abs(sum_ccl) <= size * 1.2) and abs(sum_zxj) <= 3:
                    last_valid_end = end  # Update the last valid end
                elif size >= 3:  # If the condition is not met and we have a sublist of at least size 3, break
                    break
            else:
                # Check if the current window satisfies the conditions
                if size >= 3 and (abs(sum_zxj) <= 1 or abs(sum_zxj) <= size * 0.3) and (abs(sum_ccl) <= 5 or abs(sum_ccl) <= size * 1.5):
                    last_valid_end = end  # Update the last valid end
                elif size >= 3:  # If the condition is not met and we have a sublist of at least size 3, break
                    break

        # If we found a valid sublist, add it
        if last_valid_end != -1:
            avg_zxj = mean(t['zxj'] for t in ticks[data[start]['start_index']:data[last_valid_end]['end_index']+1])
            sub_data = {
                "start_time": data[start]['start_time'],
                "end_time": data[last_valid_end]['end_time'],
                "size": last_valid_end - start + 1,
                "sum_ccl_rate": round(sum(d['ccl_diff_rate'] for d in data[start: last_valid_end+1]), 2),
                "avg_zxj": round(avg_zxj * 2) / 2 if ticks[0]['type'] == "i" else int(avg_zxj),
                "avg_ccl": int(mean(t['ccl'] for t in ticks[data[start]['start_index']:data[last_valid_end]['end_index']+1]))
            }
            valid_sublists.append(sub_data)
            # Move start to after the last valid end
            start = last_valid_end + 1
        else:
            # Move start to the next position if no valid sublist was found
            start += 1

    return valid_sublists

def statistic_sublists(results):
    up_up_cps = []
    up_down_cps = []
    down_up_cps = []
    down_down_cps = []
    for i in range(len(results)-2):
        next = i + 1
        ccl_diff = results[next]['avg_ccl'] - results[i]['avg_ccl']
        zxj_diff = results[next]['avg_zxj'] - results[i]['avg_zxj']
        if zxj_diff == 0:
            continue
        cp_rate = int(ccl_diff / zxj_diff)
        # utils.log(f"{results[i]['start_time']} to {results[next]['start_time']} {zxj_diff} {ccl_diff} {cp_rate}")
        if zxj_diff > 0:
            if ccl_diff > 0:     
                up_up_cps.append(cp_rate)
            else:
                up_down_cps.append(cp_rate)
        else:
            if ccl_diff > 0:
                down_up_cps.append(cp_rate)
            else:
                down_down_cps.append(cp_rate)
        
    statistic = {
        "up_up_avg_cp": int(mean(up_up_cps)),
        "up_up_stdev_cp": int(stdev(up_up_cps)),
        "up_up_count": len(up_up_cps),
        "up_down_avg_cp": int(mean(up_down_cps)),
        "up_down_stdev_cp": int(stdev(up_down_cps)),
        "up_down_count": len(up_down_cps),
        "down_up_avg_cp": int(mean(down_up_cps)),
        "down_up_stdev_cp": int(stdev(down_up_cps)),
        "down_up_count": len(down_up_cps),
        "down_down_avg_cp": int(mean(down_down_cps)),
        "down_down_stdev_cp": int(stdev(down_down_cps)),
        "down_down_count": len(down_down_cps)
    }
    return statistic
    
def extrema_ccl_price_rate(ticks, extremas):
    u_u_rates = []
    u_d_rates = []
    d_u_rates = []
    d_d_rates = []    
    for i in range(0, len(extremas)-1):
        two_mins_span = 12 * 2
        mean_extrema_next_index = extremas[i+1]['index']        
        mean_extrema_next_zxj = round(mean(t['zxj'] for t in ticks[mean_extrema_next_index - two_mins_span: mean_extrema_next_index + two_mins_span]), 2)
        mean_extrema_next_ccl = mean(t['ccl'] for t in ticks[mean_extrema_next_index - two_mins_span: mean_extrema_next_index + two_mins_span])
        
        mean_extrema_cur_index = extremas[i]['index']
        mean_extrema_cur_zxj = round(mean(t['zxj'] for t in ticks[mean_extrema_cur_index - two_mins_span: mean_extrema_cur_index + two_mins_span]), 2)
        mean_extrema_cur_ccl = mean(t['ccl'] for t in ticks[mean_extrema_cur_index - two_mins_span: mean_extrema_cur_index + two_mins_span])
        
        mean_zxj_diff = int(mean_extrema_next_zxj - mean_extrema_cur_zxj) if extremas[0]['type'] != "i" else round((mean_extrema_next_zxj - mean_extrema_cur_zxj)*2)/2
        mean_ccl_diff = mean_extrema_next_ccl - mean_extrema_cur_ccl
        ccl_price_rate = int(mean_ccl_diff / mean_zxj_diff if mean_zxj_diff != 0 else mean_ccl_diff)
        data = {
            'time_range': f"{extremas[i]['time']}-{extremas[i+1]['time']}",
            'zxj_diff': mean_zxj_diff,
            'rate': ccl_price_rate
        }
        if mean_zxj_diff > 0:
            if mean_ccl_diff > 0:
                data['rate_type'] = "u_u"
                u_u_rates.append(data)
            else:
                data['rate_type'] = "u_d"
                u_d_rates.append(data)
        else:
            if mean_ccl_diff > 0:
                data['rate_type'] = "d_u"
                d_u_rates.append(data)
            else:
                data['rate_type'] = "d_d"
                d_d_rates.append(data)
        
        # Add five mins data trend
        # j = extremas[i]['index']
        # while j < extremas[i+1]['index']:
        #     next = j + 12 * 5
        #     if next >= extremas[i+1]['index']:
        #         j = extremas[i+1]['index'] - 12 * 5
        #         next = extremas[i+1]['index']
            
        #     sec_30_span = 6
            
        #             # two_mins_span = 12 * 2
        #     # mean_extrema_next_index = extremas[i+1]['index']        
        #     # mean_extrema_next_zxj = round(mean(t['zxj'] for t in ticks[mean_extrema_next_index - two_mins_span: mean_extrema_next_index + two_mins_span]), 2)
        #     # mean_extrema_next_ccl = mean(t['ccl'] for t in ticks[mean_extrema_next_index - two_mins_span: mean_extrema_next_index + two_mins_span])
            
        #     # mean_extrema_cur_index = extremas[i]['index']
        #     # mean_extrema_cur_zxj = round(mean(t['zxj'] for t in ticks[mean_extrema_cur_index - two_mins_span: mean_extrema_cur_index + two_mins_span]), 2)
        #     # mean_extrema_cur_ccl = mean(t['ccl'] for t in ticks[mean_extrema_cur_index - two_mins_span: mean_extrema_cur_index + two_mins_span])
        
                
        #     inside_mean_extrema_next_zxj = round(mean(t['zxj'] for t in ticks[next - sec_30_span: next + sec_30_span]), 2)
        #     inside_mean_extrema_next_ccl = mean(t['ccl'] for t in ticks[next - sec_30_span: next + sec_30_span])
            
        #     inside_mean_extrema_cur_zxj = round(mean(t['zxj'] for t in ticks[j - sec_30_span: j + sec_30_span]), 2)
        #     inside_mean_extrema_cur_ccl= mean(t['ccl'] for t in ticks[j - sec_30_span: j + sec_30_span])
            
        #     inside_mean_zxj_diff = int(inside_mean_extrema_next_zxj - inside_mean_extrema_cur_zxj) if extremas[0]['type'] != "i" else round((inside_mean_extrema_next_zxj - inside_mean_extrema_cur_zxj)*2)/2
        #     inside_mean_ccl_diff = inside_mean_extrema_next_ccl - inside_mean_extrema_cur_ccl
        #     inside_ccl_price_rate = int(inside_mean_ccl_diff / inside_mean_zxj_diff if inside_mean_zxj_diff != 0 else inside_mean_ccl_diff)
        
        #     inside_data = {
        #         'zxj_diff': inside_mean_zxj_diff,
        #         'rate': inside_ccl_price_rate
        #     }
            
        #     # inside_zxj_threashold = 1 if extremas[0]['type'] != "i" else 0.5
            
        #     if abs(inside_mean_zxj_diff) == 0:
        #         if inside_mean_ccl_diff > 0:
        #             inside_data['rate_type'] = "n_u"
        #         else:
        #             inside_data['rate_type'] = "n_d"
        #     elif inside_mean_zxj_diff > 0:
        #         if inside_mean_ccl_diff > 0:
        #             inside_data['rate_type'] = "u_u"
        #         else:
        #             inside_data['rate_type'] = "u_d"
        #     else:
        #         if inside_mean_ccl_diff > 0:
        #             inside_data['rate_type'] = "d_u"
        #         else:
        #             inside_data['rate_type'] = "d_d"
                        
        #     utils.log(f"inside: {ticks[j]['time']}-5min {inside_data['rate_type']} {inside_data['zxj_diff']} {inside_data['rate']}")
        #     j = next
        
        data['trade_time_diff'] = int((extremas[i+1]['index'] - extremas[i]['index']) / 12)
        # utils.log(f"{data['time_range']} {data['rate_type']} {data['zxj_diff']} {data['rate']} {data['trade_time_diff']}m")
    
    rates = [u_u_rates, u_d_rates, d_u_rates, d_d_rates]
    results = []
    for rate in rates:
        if len(rate) < 2:
            continue
        avg_rate = int(mean(list(x['rate'] for x in rate)))
        stdev_rate = int(stdev(list(x['rate'] for x in rate)))
        results.append({
            'rate_type': rate[0]['rate_type'],
            'cp_avg': avg_rate,
            'cp_std': stdev_rate,
            'count': len(rate)
        })
        # utils.log(f'{rate[0]["rate_type"]} avg: {avg_rate} stdev: {stdev_rate} count: {len(rate)}')
    return results

def predict_base(res, up_type, down_type, datas, data, position, factor, print_data=False):
    past_day_span = factor['pastDay']
    win_jsp_per = factor['winJspPer']
    win_diff_per = factor['winDiffPer']
    cut_peak_day = factor['cutPeakDay']
    cut_peak_per = factor['cutPeakPer']

    predict = {}
    if up_type in res:
        predict['direction'] = "up"
        predict['price'] = max((1 + win_jsp_per) * data['jsp'],  win_diff_per * (get_past_n_day_max(datas, position, past_day_span) - data['jsp']) + data['jsp'])
        predict['per'] = predict['price'] / data['jsp']
        predict['cutPrice'] = get_past_n_day_min(datas, position, cut_peak_day) * (1 - cut_peak_per)
        predict['cutPer'] = predict['cutPrice'] / data['jsp']
    elif down_type in res:
        predict['direction'] = "down"
        predict['price'] = min((1 - win_jsp_per) * data['jsp'], data['jsp'] - win_diff_per * (data['jsp'] - get_past_n_day_min(datas, position, past_day_span)))
        predict['per'] = 2 - predict['price'] / data['jsp']
        predict['cutPrice'] = get_past_n_day_max(datas, position, cut_peak_day) * (1 + cut_peak_per)
        predict['cutPer'] = 2 - predict['cutPrice'] / data['jsp']
    if print_data:
        utils.echo_dic(predict)

    return predict

def convert_predict_price_to_current(data, predict):
    converted_predict = {}
    current_data = get_current_price(data)
    converted_predict['code'] = current_data['code']
    converted_predict['date'] = current_data['date']
    converted_predict['jsp'] = current_data['jsp']
    converted_predict['price'] = int(current_data['jsp'] * (predict['per'] if predict['direction'] == "up" else 2 - predict['per']))
    converted_predict['cutPrice'] = int(current_data['jsp'] * (predict['cutPer'] if predict['direction'] == "up" else 2 - predict['cutPer']))
    converted_predict['pricePer'] = round(predict['per'], 2)
    converted_predict['cutPer'] = round(predict['cutPer'], 2)
    return converted_predict


def get_current_price(data):
    return constance.INFO_COL.find_one({'code': data['code'], 'date': data['date']})

def verify_trade(datas, data, position, next_range, predict, predict_price, cut_price, need_max = False):
    future_datas = datas[position + 1:position + next_range + 1]
    return verify_trade_inner(future_datas, data, next_range, predict, predict_price, cut_price, need_max)
    

def verify_trade_inner(future_datas, data, next_range, predict, predict_price, cut_price, need_max):
    trade_type = ""
    trade_day = 0
    for f in future_datas:
        trade_day += 1
        if predict == "up":
            if f['zgj'] >= predict_price and f['zdj'] <= cut_price:
                trade_type = "conf"
                trade_result = 1
                break
            elif f['zgj'] >= predict_price:
                trade_type = "win"
                trade_result = predict_price / data['jsp']
                break
            elif f['zdj'] <= cut_price:
                trade_type = "cut"
                trade_result = cut_price / data['jsp']
                break
        else:
            if f['zdj'] <= predict_price and f['zgj'] >= cut_price:
                trade_type = "conf"
                trade_result = 1
                break
            if f['zdj'] <= predict_price:
                trade_type = "win"
                trade_result = 2 - predict_price / data['jsp']
                break
            elif f['zgj'] >= cut_price:
                trade_type = "cut"
                trade_result = 2 - cut_price / data['jsp']
                break

    if trade_type == "":
        trade_type = "no"
        if predict == "up":
            trade_result = future_datas[-1]['jsp'] / data['jsp']
        elif predict == "down":
            trade_result = 2 - future_datas[-1]['jsp'] / data['jsp']
        else:
            trade_result = 1

    verify_res = constance.VERIFY_COL.find_one({"type": data['type'], "date": data['date'], "range": next_range}) if need_max else None
    min_per = verify_res['minPer'] if verify_res != None else 0
    max_per = verify_res['maxPer'] if verify_res != None else 0

    return {'tradeType': trade_type, 'tradePer': trade_result, 'tradeDay': future_datas[trade_day-1]['date'], 'minPer': min_per, 'maxPer': max_per}

def statistic_candle(results, with_all = True, echo = True):
    # Final statistic
    # candleType, type,  allCount  match  rate   finalResult
    statistic = {}
    for res in results:
        if res['candleType'] not in statistic:
            statistic[res['candleType']] = {}

        if with_all:
            if 'all' not in statistic[res['candleType']]:
                statistic[res['candleType']]['all'] = {}
                statistic[res['candleType']]['all']['candleType'] = res['candleType']
                statistic[res['candleType']]['all']['type'] = 'all'
                statistic[res['candleType']]['all']['count'] = 0
                statistic[res['candleType']]['all']['match'] = 0
                statistic[res['candleType']]['all']['rate'] = 0
                statistic[res['candleType']]['all']['tradeRes'] = 1

            statistic[res['candleType']]['all']['count'] += 1
            statistic[res['candleType']]['all']['match'] += (1 if res['tradeType'] == "win" else 0)
            statistic[res['candleType']]['all']['tradeRes'] *= res['tradePer']

        if res['type'] not in statistic[res['candleType']]:
            statistic[res['candleType']][res['type']] = {}
            statistic[res['candleType']][res['type']]['candleType'] = res['candleType']
            statistic[res['candleType']][res['type']]['type'] = res['type']
            statistic[res['candleType']][res['type']]['count'] = 0
            statistic[res['candleType']][res['type']]['match'] = 0
            statistic[res['candleType']][res['type']]['rate'] = 0
            statistic[res['candleType']][res['type']]['tradeRes'] = 1
            if 'factor' in res:
                statistic[res['candleType']][res['type']]['factor'] = res['factor']

        statistic[res['candleType']][res['type']]['count'] += 1
        statistic[res['candleType']][res['type']]['match'] += (1 if res['tradeType'] == "win" else 0)
        statistic[res['candleType']][res['type']]['tradeRes'] *= res['tradePer']

    statistic_arr = []

    for k, v in statistic.items():
        for t, val in v.items():
            val['rate'] = round(val['match'] * 100.00 / val['count'], 2)
            # if val['rate'] < 30:
            #     continue
            val['tradeRes'] = round(val['tradeRes'], 4) if val['type'] != 'all' else - 1 * round(val['tradeRes'], 4)
            val['tradePowAvgRes'] = pow_base(val['count'], val['tradeRes'], base=0.9)
            statistic_arr.append(val)

    statistic_arr.sort(key=lambda x: x['tradeRes'], reverse=True)
    if echo and len(statistic_arr) > 0:
        utils.echo_dics(statistic_arr)

    return statistic_arr

def generate_result(contractType, date, candleType, candleSubType, tradeType, predict, predictPer, cutPer, tradeResult, minPer, maxPer):
    result = {}
    result['type'] = contractType
    result['date'] = date
    result['candleType'] = candleType
    result['candleSubType'] = candleSubType
    result['tradeType'] = tradeType
    result['predict'] = predict
    result['predictPer'] = predictPer
    result['cutPer'] = cutPer
    result['tradePer'] = tradeResult
    result['minPer'] = minPer
    result['maxPer'] = maxPer
    return result
    
def get_position_from_data(datas, date):
    position = -1
    for i in range(0, len(datas)):
        if datas[i]['date'] == date:
            position = i
            break
    return position


def get_past_n_day_min(data, i, n, price_type = "zdj"):
    if i - n >= 0:
        return min(list(d[price_type] for d in data[i - n:i + 1] if d[price_type] != 0))
    else:
        click.echo("{} {} {}".format(n, i, data))


def get_past_n_day_max(data, i, n, price_type="zgj"):
    if i - n >= 0:
        return max(list(d[price_type] for d in data[i - n:i + 1]))
    else:
        click.echo("{} {} {}".format(n, i, data))

def convert_array_to_obj(keys, vals):
    obj = {}
    if len(keys) == len(vals):
        for i in range(0, len(keys)):
            obj[keys[i]] = convert_val(vals[i])

    return obj

def convert_val(val):
    value = ""
    try:
        value=int(val)
    except ValueError:
        try:
            value=round(float(val), 4)
        except ValueError:
            value = val

    return value

def pow_base(pow_val, target, base=1,  final_accuracy=0.0001, accuracy=0.01):
    while True:
        try:
            temp_val = math.pow(base, pow_val)
            if temp_val == target:
                return base
            if temp_val > target:
                base -= accuracy
                if accuracy > final_accuracy:                
                    accuracy /= 10
                else:
                    return base

            base += accuracy
        except Exception as e:
            return base


def pow_times(base, target):
    times = 0
    while True:
        temp_val = math.pow(base, times)
        if temp_val >= target:
            return times
        times += 1

def get_header_by_candle_type(candle_type):
    if candle_type == "chz":
        head = "candleType,type,count,match,rate,tradeRes,pastDay,middleRate,topRate,trendPer,nearPeakPer,inPeakTrend,winJspPer,winDiffPer,cutPeakDay,cutPeakPer,tradePowAvgRes,tradeAvgRes,tradeStdev"
    elif candle_type == "abs":
        head = "candleType,type,count,match,rate,tradeRes,pastDay,bodyRate,trendPer,peakDay,winJspPer,winDiffPer,cutPeakDay,cutPeakPer,tradePowAvgRes,tradeAvgRes,tradeStdev"

    return head.split(",")


def get_factor_keys_by_candle_type(candle_type):
    head = ""
    if candle_type == "chz":
        head = "pastDay,middleRate,topRate,trendPer,nearPeakPer,inPeakTrend,winJspPer,winDiffPer,cutPeakDay,cutPeakPer"
    elif candle_type == "abs":
        head = "pastDay,bodyRate,trendPer,peakDay,winJspPer,winDiffPer,cutPeakDay,cutPeakPer"

    return head.split(",")

# 0. factor infor consists of three parts, 1.info. 2. select factor 3. trade factor
# 1. according to opt type, convert all contract type and count pair to select factor list
# 2. according to select factor, choose win selection. definition is 1. len(trade res > 1.0) >> len(trade res < 1.0) 2. len(trade res > 1.3)?
# 3. according to win selection, to get top n trade factor
# 4. combine select factor and trade factor
# candleType	type	count	match	rate	tradeRes	pastDay	middleRate	topRate	trendPer	nearPeakPer	inPeakTrend	winJspPer	winDiffPer	cutPeakDay	cutPeakPer
# chz	ru	184	64	34.78	2.6377	4	0.5	0.4	0.035	0.03	0.15	0.05	0.8	1	0.01

def expect_optmise_filter(candle_type, factor_strs, select_trade_factor_count = 3, select_factors_count=20, trade_res_threshold=1.1, avg_res_threshold = 1.005, avg_base_res_threshold = 1.005, variance_threshold = 0.5, output_path = "."):
    final_factors = []
    record = {}
    head = get_header_by_candle_type(candle_type)
    load_count = 0
    for factor_str in factor_strs:
        load_count += 1
        factor = factor_str.replace("\n", "").split(",")
        factor_id = get_factor_str_id(factor)
        if len(record) < select_factors_count and factor_id not in record:
            record[factor_id] = initialize_factor_optmise_record(factor_id)
            
        if factor_id in record:
            select_part = get_factor_str_select_part(factor_str)
            record[factor_id]['selectFactors'].add(select_part)
            record[factor_id]['factors'].append(convert_array_to_obj(head, factor))

    optmise_types = ['expect', 'winRate']    
    opt_results = {}
    for t in optmise_types:
        opt_results[t] = []

    for factor_id, factor_record in record.items():
        factors = factor_record['factors']
        trade_res_list = list((x['tradeRes'] for x in factors))
        
        # ignore factors not meet thresholds
        # 85%的情况下是盈利的，说明这个selection是不错的
        avg_res = round(mean(trade_res_list), 4)
        res_gt_one = sum(1 for x in trade_res_list if x > 1)
        v_res = round(variance(trade_res_list), 4)
        stdev_res = round(stdev(trade_res_list), 8)
        if avg_res - stdev_res < 1:
            click.echo("{} not a good selection".format(factor_id))
        # if res_gt_one * 100 / len(trade_res_list) < 60 and avg_res < avg_res_threshold:
        #     record[factor_id] = {}
            continue
        
        # weighted average each trade factor
        sum_res = sum(trade_res_list)
        weighted_avg_wjp = round(sum(list(x['winJspPer'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        weighted_avg_wdp = round(sum(list(x['winDiffPer'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        weighted_avg_cpd = round(sum(list(x['cutPeakDay'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        weighted_avg_cpp = round(sum(list(x['cutPeakPer'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        max_wjp = max(list(x['winJspPer'] for x in factors))
        min_wjp = min(list(x['winJspPer'] for x in factors))
        max_cpp = max(list(x['cutPeakPer'] for x in factors))
        min_cpp = min(list(x['cutPeakPer'] for x in factors))
        middle_wjp = round((max_wjp + min_wjp) / 2, 4)
        middle_cpp = round((max_cpp + min_cpp) / 2, 4)

        # choose one selection and three trade factor
        # TODO according to factor's stdev
        cut_factor_keys = head[-4:]
        for i in range(0, len(cut_factor_keys)):
            factors.sort(key=lambda x: x[cut_factor_keys[i]], reverse=i == 2)
        
        for optmise_type in optmise_types:
            if optmise_type == "expect":
                factors.sort(key=lambda x: x['rate'], reverse=True)
                factors.sort(key=lambda x: x['tradeRes'], reverse=True)
            elif optmise_type == "winRate":
                factors.sort(key=lambda x: x['tradeRes'], reverse=True)
                factors.sort(key=lambda x: x['rate'], reverse=True)
            else:
                break
                
            selected_trade_count = 0
            selected_trade_res = 0
            for factor in factors:
                if factor['tradeRes'] != selected_trade_res:
                    opt_result = {}
                    opt_result['type'] = factor['type']
                    opt_result['candleType'] = factor['candleType']
                    opt_result['count'] = factor['count']
                    opt_result['rate'] = factor['rate']
                    opt_result['tradeRes'] = factor['tradeRes']
                    opt_result['tradePowAvgRes'] = factor['tradePowAvgRes']
                    opt_result['tradeAvgRes'] = factor['tradeAvgRes']
                    opt_result['tradeStdev'] = factor['tradeStdev']
                    opt_result['selectionAvgRes'] = avg_res
                    opt_result['selectionStdevRes'] = stdev_res
                    # if opt_result['tradePowAvgRes'] < avg_base_res_threshold or (factor['tradeAvgRes'] - 0.5 * factor['tradeStdev']) < 1:
                    # 0.3 = 60%
                    if (factor['tradeAvgRes'] - 0.3 * factor['tradeStdev']) < 1:
                        continue

                    factor_keys = get_factor_keys_by_candle_type(opt_result['candleType'])
                    for k in factor_keys:
                        opt_result[k] = factor[k]

                    opt_result['wAvgWjp'] = weighted_avg_wjp
                    opt_result['wAvgWdp'] = weighted_avg_wdp
                    opt_result['wAvgCpd'] = weighted_avg_cpd
                    opt_result['wAvgCpp'] = weighted_avg_cpp
                    opt_result['midWjp'] = middle_wjp
                    opt_result['midCpp'] = middle_cpp
                    
                    opt_results[optmise_type].append(opt_result)
                    selected_trade_count += 1
                    selected_trade_res = factor['tradeRes']
                
                if selected_trade_count >= select_trade_factor_count:
                    break

    for optmise_type in optmise_types:
        opt_res = opt_results[optmise_type]
        if len(opt_res) > 0:
            contract_type = opt_res[0]['type']
            opt_res.sort(key=lambda x: x['selectionAvgRes'], reverse=True)
            utils.convert_dic_to_csv("{}/{}_{}_{}_best_factors_stdev".format(output_path, optmise_type, contract_type, candle_type), opt_res)
        else:
            click.echo("There is no optmised data")
        

def initialize_factor_optmise_record(factor_id):
    temp = {}
    temp['factorId'] = factor_id
    temp["winC"] = 0
    temp["lossC"] = 0
    temp["resSum"] = 0
    temp["selectFactors"] = set()
    temp["factors"] = []
    temp['tradeFactors'] = []
    return temp

def get_factor_str_id(factors):
    return ",".join(factors[0:3])

def get_factor_str_select_part(factors):
    return ",".join(factors[6:-7])

def get_factor_str_trade_part(factors):
    return ",".join(factors[-7:-3])

def get_factor_dic(factor):
    factor_dic = {}
    if "candleType" in factor:
        candle_type = factor['candleType']
        keys = get_factor_keys_by_candle_type(candle_type)
        for key in keys:
            factor_dic[key] = factor[key]

    return factor_dic

def analysis_max_min_for_select_datas(datas, next_range):
    maxs = []
    mins = []
    select_datas = []
    for data in datas:
        verify = constance.VERIFY_COL.find_one({"type": data['type'], "date": data['date'], "range": next_range})
        if verify == None:
            click.echo("None verify data: {}, {}, {}".format(
                data['type'], data['date'], next_range))
            continue

        maxs.append(verify['maxPer'])
        mins.append(verify['minPer'])
        select_datas.append("{}-{}".format(data['type'], data['date']))
    
    max_avg = round(mean(maxs), 4)
    max_stdev = round(stdev(maxs), 8)
    min_avg = round(mean(mins), 4)
    min_stdev = round(stdev(mins), 8)

    return {
        "maxAvg": round(mean(maxs), 4),
        "maxStdev": round(stdev(maxs), 8),
        "up16": max_avg + max_stdev,
        "up31": max_avg + 0.5 * max_stdev,
        "up69": max_avg - 0.5 * max_stdev,
        "up84": max_avg - max_stdev,
        "minAvg": round(mean(mins), 4),
        "minStdev": round(stdev(mins), 8),
        "down16": min_avg - min_stdev,
        "down31": min_avg - 0.5 * min_stdev,
        "down69": min_avg + 0.5 * min_stdev,
        "down84": min_avg + min_stdev,
        "tradeU84D16": (max_avg - max_stdev) * 0.84 + (min_avg - min_stdev) * 0.16,
        "tradeU84D31": ((max_avg - max_stdev) * 0.84 + (min_avg - 0.5 * min_stdev) * 0.31) / 1.15,
        "tradeU69D16": ((max_avg - 0.5 * max_stdev) * 0.69 + (min_avg - min_stdev) * 0.16) / 0.85,
        "tradeU69D31": (max_avg - 0.5 * max_stdev) * 0.69 + (min_avg - 0.5 * min_stdev) * 0.31,
        "tradeU16D84": (max_avg + max_stdev) * 0.16 + (min_avg + min_stdev) * 0.84,
        "tradeU31D84": ((max_avg + 0.5 * max_stdev) * 0.31 + (min_avg + min_stdev) * 0.84) / 1.15,
        "tradeU16D69": ((max_avg + max_stdev) * 0.16 + (min_avg + 0.5 * min_stdev) * 0.69) / 0.85,
        "tradeU31D69": (max_avg + 0.5 * max_stdev) * 0.31 + (min_avg + 0.5 * min_stdev) * 0.69,
        "tradeU50D50": max_avg * 0.5 + min_avg * 0.5,
        "selectData" : "|".join(select_datas)
    } if len(maxs) > 1 and len(mins) > 1 else{}
    

def available_types():
    max_date = constance.MAIN_COL.find_one({"type": "ru"}, sort=[('date', -1)])['date']
    available_contracts = list(constance.MAIN_COL.find(
        {"date": max_date, "cjl": {"$gt": 50000}}))
    types = list(x['type'] for x in available_contracts)
    types.sort()
    return types


def available_codes():
    max_date = constance.MAIN_COL.find_one(
        {"type": "ru"}, sort=[('date', -1)])['date']
    available_contracts = list(constance.MAIN_COL.find({"date": max_date, "cjl": {"$gt": 50000}}))
    types = list(x['code'] for x in available_contracts)
    types.sort()
    return types

def get_percentage(start, end):
    return round((end - start) * 100 / end, 4)


def get_zxj_trend_value(minute, percentage):
    trend_point = 0
    abs_per = abs(percentage)
    positive = 1 if percentage >= 0 else -1
    if minute == 2:
        if abs_per <= 0.025:
            trend_point = 1
        elif abs_per <= 0.05:
            trend_point = 2
        elif abs_per <= 0.08:
            trend_point = 3
        elif abs_per <= 0.1:
            trend_point = 4
        elif abs_per <= 0.15:
            trend_point = 5
        elif abs_per <= 0.2:
            trend_point = 6
        elif abs_per <= 0.3:
            trend_point = 7
        elif abs_per <= 0.4:
            trend_point = 8
        elif abs_per <= 0.5:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 5:
        if abs_per <= 0.05:
            trend_point = 1
        elif abs_per <= 0.10:
            trend_point = 2
        elif abs_per <= 0.15:
            trend_point = 3
        elif abs_per <= 0.25:
            trend_point = 4
        elif abs_per <= 0.4:
            trend_point = 5
        elif abs_per <= 0.6:
            trend_point = 6
        elif abs_per <= 0.8:
            trend_point = 7
        elif abs_per <= 1:
            trend_point = 8
        elif abs_per <= 1.5:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 20:
        if abs_per <= 0.1:
            trend_point = 1
        elif abs_per <= 0.20:
            trend_point = 2
        elif abs_per <= 0.35:
            trend_point = 3
        elif abs_per <= 0.6:
            trend_point = 4
        elif abs_per <= 0.8:
            trend_point = 5
        elif abs_per <= 1.1:
            trend_point = 6
        elif abs_per <= 1.5:
            trend_point = 7
        elif abs_per <= 2:
            trend_point = 8
        elif abs_per <= 3:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 60:
        if abs_per <= 0.2:
            trend_point = 1
        elif abs_per <= 0.30:
            trend_point = 2
        elif abs_per <= 0.45:
            trend_point = 3
        elif abs_per <= 0.7:
            trend_point = 4
        elif abs_per <= 1:
            trend_point = 5
        elif abs_per <= 1.5:
            trend_point = 6
        elif abs_per <= 2.1:
            trend_point = 7
        elif abs_per <= 2.8:
            trend_point = 8
        elif abs_per <= 4:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 120:
        if abs_per <= 0.2:
            trend_point = 1
        elif abs_per <= 0.30:
            trend_point = 2
        elif abs_per <= 0.45:
            trend_point = 3
        elif abs_per <= 0.7:
            trend_point = 4
        elif abs_per <= 1:
            trend_point = 5
        elif abs_per <= 1.5:
            trend_point = 6
        elif abs_per <= 2.1:
            trend_point = 7
        elif abs_per <= 2.8:
            trend_point = 8
        elif abs_per <= 6:
            trend_point = 9
        else:
            trend_point = 10

    return positive * trend_point


def get_ccl_trend_value(minute, percentage):
    trend_point = 0
    abs_per = abs(percentage)
    positive = 1 if percentage >= 0 else -1
    if minute == 2:
        if abs_per <= 0.005:
            trend_point = 1
        elif abs_per <= 0.01:
            trend_point = 2
        elif abs_per <= 0.02:
            trend_point = 3
        elif abs_per <= 0.03:
            trend_point = 4
        elif abs_per <= 0.05:
            trend_point = 5
        elif abs_per <= 0.1:
            trend_point = 6
        elif abs_per <= 0.2:
            trend_point = 7
        elif abs_per <= 0.3:
            trend_point = 8
        elif abs_per <= 0.4:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 5:
        if abs_per <= 0.02:
            trend_point = 1
        elif abs_per <= 0.05:
            trend_point = 2
        elif abs_per <= 0.10:
            trend_point = 3
        elif abs_per <= 0.15:
            trend_point = 4
        elif abs_per <= 0.2:
            trend_point = 5
        elif abs_per <= 0.3:
            trend_point = 6
        elif abs_per <= 0.4:
            trend_point = 7
        elif abs_per <= 0.5:
            trend_point = 8
        elif abs_per <= 0.6:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 10:
        if abs_per <= 0.03:
            trend_point = 1
        elif abs_per <= 0.075:
            trend_point = 2
        elif abs_per <= 0.15:
            trend_point = 3
        elif abs_per <= 0.225:
            trend_point = 4
        elif abs_per <= 0.3:
            trend_point = 5
        elif abs_per <= 0.45:
            trend_point = 6
        elif abs_per <= 0.6:
            trend_point = 7
        elif abs_per <= 0.75:
            trend_point = 8
        elif abs_per <= 0.9:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 20:
        if abs_per <= 0.05:
            trend_point = 1
        elif abs_per <= 0.1:
            trend_point = 2
        elif abs_per <= 0.2:
            trend_point = 3
        elif abs_per <= 0.35:
            trend_point = 4
        elif abs_per <= 0.4:
            trend_point = 5
        elif abs_per <= 0.6:
            trend_point = 6
        elif abs_per <= 0.8:
            trend_point = 7
        elif abs_per <= 1:
            trend_point = 8
        elif abs_per <= 1.5:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 60:
        if abs_per <= 0.15:
            trend_point = 1
        elif abs_per <= 0.25:
            trend_point = 2
        elif abs_per <= 0.5:
            trend_point = 3
        elif abs_per <= 0.8:
            trend_point = 4
        elif abs_per <= 1.2:
            trend_point = 5
        elif abs_per <= 2:
            trend_point = 6
        elif abs_per <= 3:
            trend_point = 7
        elif abs_per <= 5:
            trend_point = 8
        elif abs_per <= 8:
            trend_point = 9
        else:
            trend_point = 10
    elif minute == 120:
        if abs_per <= 0.3:
            trend_point = 1
        elif abs_per <= 0.55:
            trend_point = 2
        elif abs_per <= 0.9:
            trend_point = 3
        elif abs_per <= 1.5:
            trend_point = 4
        elif abs_per <= 2.5:
            trend_point = 5
        elif abs_per <= 4:
            trend_point = 6
        elif abs_per <= 6:
            trend_point = 7
        elif abs_per <= 9:
            trend_point = 8
        elif abs_per <= 12:
            trend_point = 9
        else:
            trend_point = 10

    return positive * trend_point

CCL_LIMIT={
    "rb": 1200000,
    "i": 600000,
    "oi": 250000,
    "y": 350000
}

def get_past_n_days_ccl_min_max(type, days = 4):
    start_t = time.time()
    # current_date = datetime.datetime.now().strftime("%Y-%m-%d")
    # Perform the aggregation
    pipeline = [
        {
        "$match": {
            "type": type  # Apply filter to only include documents with type 'rb'
            }
        },
        {
            "$group": {
                "_id": "$date",  # Replace with your actual field name
                "latest": {"$max": "$date"}  # Assuming the date field is unique
            }
        },
        {"$sort": {"latest": -1}},
        {"$limit": days},
        {
            "$project": {
                "_id": 0,
                "date": "$_id"
            }
        }
    ]

    latest_dates = [d['date'] for d in constance.REAL_TIME_TICK_COL.aggregate(pipeline)]
    latest_dates.sort()
    daily_info = {}
    
    for i in range(0, len(latest_dates) - 1):
        start_time = latest_dates[i] + "21:00:00"
        end_time = latest_dates[i + 1] + "15:00:00"
        start_tick = constance.REAL_TIME_TICK_COL.find_one({"type": type, "time" :{"$gte": start_time},"ccl": {"$gt": CCL_LIMIT[type]}}, sort=[("time", 1)])
        end_tick = constance.REAL_TIME_TICK_COL.find_one({"type": type, "time" :{"$lte": end_time}, "ccl": {"$gt": CCL_LIMIT[type]}}, sort=[("time", -1)])
        static_pipeline = [
            {
                "$match": {
                    "type": type,
                    "time": {"$gte": start_time, "$lte": end_time},  # Greater than or equal to the filter date,
                    "ccl": {"$gt": CCL_LIMIT[type]}
                }
            },
            {
                "$group": {
                    "_id": None,  # Group all matching documents together
                    # "average": {"$avg": f"$ccl"},
                    # "average_zxj": {"$avg": f"$zxj"},
                    "minimum": {"$min": f"$ccl"},
                    "maximum": {"$max": f"$ccl"},
                }
            }
        ]
            # Execute the aggregation pipeline
        stats = list(constance.REAL_TIME_TICK_COL.aggregate(static_pipeline))
        
        daily_info[latest_dates[i+1]] = {}
        daily_info[latest_dates[i+1]]["start"] = start_tick['ccl']
        daily_info[latest_dates[i+1]]["end"] = end_tick['ccl']
        # Display the results
        for stat in stats:
            daily_info[latest_dates[i+1]]["min"] = stat['minimum']
            daily_info[latest_dates[i+1]]["max"] = stat['maximum']
        
        min_tick = constance.REAL_TIME_TICK_COL.find_one({"type": type, "time": {"$gte": start_time, "$lte": end_time}, "ccl": daily_info[latest_dates[i+1]]["min"]})
        max_tick = constance.REAL_TIME_TICK_COL.find_one({"type": type, "time": {"$gte": start_time, "$lte": end_time}, "ccl": daily_info[latest_dates[i+1]]["max"]})
        zxj_diff = int(max_tick['zxj'] - min_tick['zxj']) if type != "i" else round((max_tick['zxj'] - min_tick['zxj'])*2)/2
        
        daily_info[latest_dates[i+1]]["close_diff"] = end_tick['ccl'] - start_tick['ccl']
        daily_info[latest_dates[i+1]]["diff"] = f"{daily_info[latest_dates[i+1]]['max'] - daily_info[latest_dates[i+1]]['min']}/{zxj_diff}"
        

    # utils.log(daily_info)
    utils.log(f"Done get_past_n_days_ccl_min_max({type}, {days}), using {int((time.time() - start_t)*1000)}ms")
    return daily_info
    
    # datas = list(constance.INFO_COL.find({"type": type}).sort([("date", -1)]).limit())
    # maxs = list(x['ccl'] for x in datas)
    # mins = list(x['ccl'] for x in datas)
    # return max(maxs), min(mins)


def get_stable_ccl_time(ticks):
    # sorted_ticks = sorted(ticks, key=lambda x: x['time'])
    data = get_continuous_status(ticks)
    results = find_stable_sublists(ticks, data, by="ccl")
    return results
    # return {
    #     current_date: statistic_sublists(results)
    # }
    
def get_cp_rate_by_exrema_price(ticks):
    extremas =  find_extrema(ticks, window=720, column='zxj')
    return extrema_ccl_price_rate(ticks, extremas)

def get_past_min_max_infor(ticks, column="zxj"):
    start_time = time.time()
    start_tick = None
    for d in ticks:
        if d['cjl'] > 0:
            start_tick = d
            break
    
    max_data = max(ticks, key=lambda x: x[column])
    min_data = min(ticks, key=lambda x: x[column])        
    
    if max_data['time'] > min_data['time']:            
        start_to_min_duration = int(date_utils.min_diff(start_tick['time'], min_data['time']))
        min_to_max_duration = int(date_utils.min_diff(min_data['time'], max_data['time']))
        max_to_current_duration = int(date_utils.min_diff(max_data['time'], ticks[-1]['time']))
        start_to_current_duration = int(date_utils.min_diff(start_tick['time'], ticks[-1]['time']))
        
        titles =[f"{column.upper()} {start_tick['time'][11:-4]}", f"Min {start_to_min_duration}m", f"Max {min_to_max_duration}m", f"Now {max_to_current_duration}m", f"S2Now {start_to_current_duration}m"]
        price_info = [f"{start_tick['zxj']}", f"{min_data['zxj']}", f"{max_data['zxj']}", f"{ticks[-1]['zxj']}", f"{int(ticks[-1]['zxj'] - start_tick['zxj']) if ticks[-1]['type'] != 'i' else round((ticks[-1]['zxj'] - start_tick['zxj'])*2)/2}"]
        ccl_info = [f"{start_tick['ccl']}", f"{min_data['ccl']}", f"{max_data['ccl']}", f"{ticks[-1]['ccl']}", f"{ticks[-1]['ccl'] - start_tick['ccl']}"]
        # price_ccl_power = ["C/P", "", f"{int((min_data['ccl'] - start_tick['ccl'])/(min_data['zxj'] - start_tick['zxj'])) if min_data['zxj'] - start_tick['zxj'] != 0 else 0}", f"{int((max_data['ccl'] - min_data['ccl'])/(max_data['zxj'] - min_data['zxj'])) if max_data['zxj'] - min_data['zxj'] != 0 else 0}", f"{int((ticks[-1]['ccl'] - max_data['ccl'])/(ticks[-1]['zxj'] - max_data['zxj'])) if ticks[-1]['zxj'] - max_data['zxj'] != 0 else 0}"]

    elif max_data['time'] < min_data['time']:
        start_to_max_duration = int(date_utils.min_diff(start_tick['time'], max_data['time']))
        max_to_min_duration = int(date_utils.min_diff(max_data['time'], min_data['time']))
        min_to_current_duration = int(date_utils.min_diff(min_data['time'], ticks[-1]['time']))
        start_to_current_duration = int(date_utils.min_diff(start_tick['time'], ticks[-1]['time']))
        
        titles = [f"{column.upper()} {start_tick['time'][11:-4]}", f"Max {start_to_max_duration}m", f"Min {max_to_min_duration}m", f"Now {min_to_current_duration}m", f"S2Now {start_to_current_duration}m"]
        price_info = [f"{start_tick['zxj']}", f"{max_data['zxj']}", f"{min_data['zxj']}", f"{ticks[-1]['zxj']}", f"{int(ticks[-1]['zxj'] - start_tick['zxj']) if ticks[-1]['type'] != 'i' else round((ticks[-1]['zxj'] - start_tick['zxj'])*2)/2}"]
        ccl_info = [f"{start_tick['ccl']}", f"{max_data['ccl']}", f"{min_data['ccl']}", f"{ticks[-1]['ccl']}", f"{ticks[-1]['ccl'] - start_tick['ccl']}"]
        # price_ccl_power = ["C/P", "", f"{int((max_data['ccl'] - start_tick['ccl'])/(max_data['zxj'] - start_tick['zxj'])) if max_data['zxj'] - start_tick['zxj'] != 0 else 0}", f"{int((min_data['ccl'] - max_data['ccl'])/(min_data['zxj'] - max_data['zxj'])) if min_data['zxj'] - max_data['zxj'] != 0 else 0}", f"{int((ticks[-1]['ccl'] - min_data['ccl'])/(ticks[-1]['zxj'] - min_data['zxj'])) if ticks[-1]['zxj'] - min_data['zxj'] != 0 else 0}"]
        # price_info = f"ZXJ: {start_tick['zxj']} - {max_data['zxj']}({int(max_data['zxj'] - start_tick['zxj'])}/{start_to_max_duration}m) - {min_data['zxj']}({int(min_data['zxj'] - max_data['zxj'])}/{max_to_min_duration}m) - {ticks[-1]['zxj']}({int(ticks[-1]['zxj'] - min_data['zxj'])}/{min_to_current_duration}m)"
        # ccl_info = f"CCL: {start_tick['ccl']} - {max_data['ccl']}({int(max_data['ccl'] - start_tick['ccl'])}) - {min_data['ccl']}({int(min_data['ccl'] - max_data['ccl'])}) - {ticks[-1]['ccl']}({int(ticks[-1]['ccl'] - min_data['ccl'])})"
        # price_ccl_power = f"C/P: {int((max_data['ccl'] - start_tick['ccl'])/(max_data['zxj'] - start_tick['zxj'])) if max_data['zxj'] - start_tick['zxj'] != 0 else 0} - {int((min_data['ccl'] - max_data['ccl'])/(min_data['zxj'] - max_data['zxj'])) if min_data['zxj'] - max_data['zxj'] != 0 else 0} - {int((ticks[-1]['ccl'] - min_data['ccl'])/(ticks[-1]['zxj'] - min_data['zxj'])) if ticks[-1]['zxj'] - min_data['zxj'] != 0 else 0}"
    
    utils.log(f"Done get_past_min_max_infor({len(ticks)}, {column}), using {int((time.time() - start_time)*1000)}ms")    
    return [
        titles, price_info, ccl_info
    ]
    
if __name__ == "__main__":
    # LOGGER.info(convert_val("0.5"))
    # LOGGER.info(convert_val("5"))
    # LOGGER.info(convert_val("a"))
    # click.echo(pow_times(1.045, 300))
    # click.echo(pow_base(9, 3.44))
    # get_past_n_days_ccl_min_max("rb")
    
    
    ticks = list(constance.REAL_TIME_TICK_COL.find({"type":"i", "date":{"$gte":"2023-10-20", "$lte":"2023-11-01"}}).sort([("time", -1)]).limit(int(12 * 60 * 5.8 * 30)))
    # utils.log(f"start time {ticks[0]['time']} end time {ticks[-1]['time']}")
    # similar_ticks = find_history(ticks[60:], 340000, 'ccl', 5)
    # utils.log(f'{ticks[0]["time"]} {ticks[0]["zxj"]} {ticks[0]["ccl"]}')
    # for tick in similar_ticks:
    #     utils.log(f'{tick["time"]} {tick["zxj"]} {tick["ccl"]}')
    
    # utils.log("=====================================")   
    # similar_ticks = find_history(ticks[60:], 8398, 'zxj', 5)
    # utils.log(f'{ticks[0]["time"]} {ticks[0]["zxj"]} {ticks[0]["ccl"]}')
    # for tick in similar_ticks:
    #     utils.log(f'{tick["time"]} {tick["zxj"]} {tick["ccl"]}')
    
    
    
        
    sorted_ticks = sorted(ticks, key=lambda x: x['time'])
    data = get_continuous_status(sorted_ticks)
    results = find_stable_sublists(sorted_ticks, data, by="ccl")
    
    # statistic_sublists(results)
    
    # results = find_stable_sublists(sorted_ticks, data, by="zxj")
    # statistic_sublists(results)
    for res in results:
        utils.log(res)
    
    
    extremas =  find_extrema(sorted_ticks, window=720, column='zxj')
    extrema_ccl_price_rate(sorted_ticks, extremas)
    
    # extremas =  find_extrema(sorted_ticks, window=720, column='ccl')
    # extrema_ccl_price_rate(sorted_ticks, extremas)
