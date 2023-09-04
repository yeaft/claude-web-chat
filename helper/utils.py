import time
import datetime
import click
import json
import hmac
import hashlib
import base64
import urllib.parse
import requests
import pytz
# import constance
from helper import constance

def log(msg):    
    format = "[%Y-%m-%d %H:%M:%S]"
    current_time = datetime.datetime.now(pytz.timezone("Asia/Shanghai")).strftime(format)
    click.echo("{}: {}".format(current_time, msg))

def echo_dics(datas, output_head=True, output_val=True, min_head_length=6, max_size=-1):
    if len(datas) < 1:
        return
    head = ""
    keys = []
    format_str = ""
    msg = ""
    for key, val in datas[0].items():
        if key == "_id":
            continue
        keys.append(str(key))

        length = max(len(str(val)), len(str(key)),
                     min_head_length) if str(key) != "date" else 8
        format_str += "{:<" + str(length) + "} "

    format_str += "\n"
    if output_head:
        msg += format_str.format(*keys)
        click.echo(" " + format_str.format(*keys)[:-1])

    if output_val:
        cal_datas = datas[:] if max_size < 0 else datas[:max_size]
        for d in cal_datas:
            vals = []
            for key, val in d.items():
                if key == "_id":
                    continue
                vals.append(val)

            if (len(keys) == len(vals)):
                msg += format_str.format(*vals)
                click.echo(" " + format_str.format(*vals)[:-1])
            else:
                msg += (" ".join(list(str(x) for x in vals)) + "\n")
                click.echo(" " + " ".join(list(str(x) for x in vals)))

    return msg


def convert_dics_str(datas, output_head=True, output_val=True, min_head_length=6, max_size=-1):
    head = ""
    keys = []
    format_str = ""
    res = ""
    for key, val in datas[0].items():
        if key == "_id":
            continue
        keys.append(str(key))

        length = max(len(str(val)), len(str(key)),
                     min_head_length) if str(key) != "date" else 8
        format_str += "{:<" + str(length) + "} "

    if output_head:
        res += format_str.format(*keys) + "\n"

    if output_val:
        cal_datas = datas[:] if max_size < 0 else datas[:max_size]
        for d in cal_datas:
            vals = []
            for key, val in d.items():
                if key == "_id":
                    continue
                vals.append(val)

            if (len(keys) == len(vals)):
                res += format_str.format(*vals) + "\n"
            else:
                res += "  ".join(list(str(x) for x in vals)) + "\n"

    return res


def echo_dic(data, output_head=True, output_val=True, min_head_length=6):
    head = ""
    keys = []
    format_str = ""
    for key, val in data.items():
        if key == "_id":
            continue
        keys.append(str(key))
        length = max(len(str(key)), min_head_length)
        format_str += "{:<" + str(length) + "} "

    if output_head:
        click.echo(format_str.format(*keys))

    vals = []
    for key, val in data.items():
        if key == "_id":
            continue
        vals.append(val)

    if output_val:
        click.echo(format_str.format(*vals))


def convert_dic_to_csv(name, data, replace_head_pair={}, is_new=True):
    name = name + ("_" + str(time.time()) + ".csv" if is_new else ".csv")
    with open(name, "w") as f:
        if len(data) > 0:
            head = ""
            keys = []
            for key, val in data[0].items():
                if key in replace_head_pair:
                    head += replace_head_pair[key] + ","
                    keys.append(replace_head_pair[key])
                else:
                    head += str(key) + ","
                    keys.append(str(key))
            head = head[:-1]
            f.write(head + "\n")

            for d in data:
                line = ""
                for key in keys:
                    if key not in d:
                        line += ","
                    else:
                        val = d[key]
                        if isinstance(val, list):
                            line += "-".join(val) + ","
                        else:
                            line += str(val) + ","
                line = line[:-1]
                f.write(line + "\n")

def convert_list_to_csv(name, data):
    name = name + "_" + str(time.time()) + ".csv"
    with open(name, "w") as f:
        if len(data) > 0:
            for d in data:
                f.write(d + "\n")


def encode_str(string):
    index = 1
    res_string = ""
    chr_max = 10240
    str_len = len(string)
    if str_len < chr_max:
        rate = int(chr_max / str_len)
    else:
        rate = round(chr_max / str_len, 4)
    for c in string:
        offset = int(index * rate)
        res_string += chr(ord(c) + offset)
        index += 1
    return res_string


def decode_str(string):
    index = 1
    res_string = ""
    chr_max = 10240
    str_len = len(string)
    if str_len < chr_max:
        rate = int(chr_max / str_len)
    else:
        rate = round(chr_max / str_len, 4)
    for c in string:
        offset = int(index * rate)
        res_string += chr(ord(c) - offset)
        index += 1
    return res_string


def create_array_for_diction_element(diction, key):
    if key not in diction:
        diction[key] = []


def create_obj_for_diction_element(diction, key):
    if key not in diction:
        diction[key] = {}


def create_int_for_diction_element(diction, key):
    if key not in diction:
        diction[key] = 0

def is_number(s):
    try:
        int(s)
    except ValueError:
        return False

    return True

# curl 'https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx' \
#     - H 'Content-Type: application/json' \
#     - d '{"msgtype": "text","text": {"content": "我就是我, 是不一样的烟火"}}'


def send_ding_msg(msg, log_message=True):
    timestamp = str(round(time.time() * 1000))
    secret = 'SECc7fae5d4a91c7f001d6964edcb509ddea421a0ffe5521e8e72e70a1cf130f322'
    secret_enc = secret.encode('utf-8')
    string_to_sign = '{}\n{}'.format(timestamp, secret)
    string_to_sign_enc = string_to_sign.encode('utf-8')
    hmac_code = hmac.new(secret_enc, string_to_sign_enc,
                         digestmod=hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    headers = {"Content-Type": "application/json"}
    r = requests.post(constance.DING_URL_FORMAT.format(timestamp, sign),
                      headers=headers, data=json.dumps(ding_msg(msg)))
    if log_message:
        click.echo("Send message {}".format(msg))

    click.echo("Send result {}".format(r.text))


def ding_msg(msg):
    return {
        "msgtype": "text",
        "text": {
            "content": msg
        },
        "at": {
            # "atMobiles": [
            #     "17600180726"
            # ],
            "isAtAll": False
        }
    }
