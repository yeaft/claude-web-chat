#!/usr/bin/python3

# from ..helper.constance import MAIN_COL, TICK5M_COL, TICK5Main_COL
from ..helper.constance import *
import click

import time

def import_to_db(path):
    with open(path, "r") as f:
        count = 0
        datas = []
        start_time = time.time()
        for line in f.readlines():
            count += 1
            if count == 1:                
                continue
            
            data_str = line.replace("\r", "").replace("\n", "")
            data_arr = data_str.split(",")
            data = {
                "code": data_arr[1],
                "time": data_arr[2].replace(":","").replace("-",""),
                "kpj": data_arr[3],
                "zgj": data_arr[4],
                "zdj": data_arr[5],
                "spj": data_arr[6],
                "cjl": data_arr[7],
                "cje": data_arr[8],
                "ccl": data_arr[9]
            }
            datas.append(data)
            if count % 100000 == 0:
                TICK5M_COL.insert_many(datas)
                datas = []
                click.echo("Upload {}, using {}s".format(count, round(time.time()-start_time, 2)))

        if len(datas) > 0:
            TICK5M_COL.insert_many(datas)

def to_all_file():
    files = get_files_from_directory("E:/BaiduNetdiskDownload")
    # click.echo("{}".format(len(files)))
    csv_path_format = "E:/data/all.csv"
    count = 0
    files.sort()
    type_path = {}
    
    for file in files:
        if "主力" in file or "0001" in file:
            continue
        
        file_name = file.split("\\")[-1].split(".")[0].lower()
        number_str = ""
        contract_type = ""
        for c in file_name:
            if is_number(c):
                number_str += c
            else:
                contract_type += c

        origin_code = ""
        # csv_path = csv_path_format.format(contract_type)
        # if contract_type not in type_path:
        #     # click.echo(contract_type)
        #     type_path[contract_type] = 1
        csv_path = csv_path_format
        # continue
        
        # if contract_type == "":
        #     click.echo(file)
        #     click.echo("{} {} {}".format(file_name, contract_type, number_str))
        #     return
        # else:
        #     continue
        with open(csv_path, "a", encoding="utf-8") as fw:
            if contract_type not in type_path:
                fw.write("market,code,time,kpj,zgj,zdj,spj,cjl,cje,ccl,date\r\n")
                type_path[contract_type] = csv_path
            
            with open(file, "r") as fr:
                for line in fr.readlines()[1:]:
                    line = line.replace("-", "").replace(":", "").replace("\r","").replace("\n","").lower()
                    line_arr = line.split(",")
                    # cje = line_arr[8]
                    # if float(cje) < 1000000:
                    #     continue

                    if origin_code == "":
                        year_prefix = line_arr[2][2:3]
                        origin_code = file.split("\\")[-1].split(".")[0].lower()
                        origin_code = contract_type + year_prefix + number_str[-3:]

                    date = str(line_arr[2][0:8])
                    line_arr[1] = origin_code
                    fw.write(",".join(line_arr) + "," + date + "\r\n")
                    count += 1

    click.echo("All data size {}".format(count))

def tick_5m_to_main():
    types = MAIN_COL.distinct("type")
    for t in types:
        infos = list(MAIN_COL.find({"type":t, "date":{"$gte":"20110101"}}).sort("date", ASCENDING))
        start_date = infos[0]['date']
        end_date = ""
        last_code = infos[0]['code'].replace("\t","")
        for i in range(1, len(infos)):
            info = infos[i]
            code = info['code'].replace("\t", "")
            number_count = 0
            if code != last_code:
                end_date = infos[i-1]['date']
                for c in last_code:
                    if is_number(c):
                        number_count += 1
                if number_count >= 4:
                    real_code = info['type'].lower() + code[-4:]
                else:
                    real_code = info['type'].lower() + end_date[2:3] + code[-3:]

                ticks_5m = list(TICK5M_COL.find({"code": real_code, "time": {"$gte": "{} 000000".format(start_date), "$lte": "{} 240000".format(end_date)}}))
                if len(ticks_5m) < 1:
                    click.echo("Error {}-{}, code {} real code {}".format(start_date, end_date, code, real_code))
                    click.echo("Query: {}".format({"code": real_code, "time": {"$gte": "{} 000000".format(start_date), "$lte": "{} 240000".format(end_date)}}))
                else:
                    TICK5Main_COL.insert_many(ticks_5m)

                last_code = code
                start_date = info['date']

        end_date = infos[-1]['date']
        if start_date <= end_date:
            code = infos[-1]['code'].replace("\t", "")
            number_count = 0
            for c in last_code:
                if is_number(c):
                    number_count += 1
            if number_count >= 4:
                real_code = infos[-1]['type'].lower() + code[-4:]
            else:
                real_code = infos[-1]['type'].lower() + end_date[2:3] + code[-3:]

            ticks_5m = list(TICK5M_COL.find({"code": real_code, "time": {"$gte": "{} 000000".format(start_date), "$lte": "{} 240000".format(end_date)}}))
            if len(ticks_5m) < 1:
                click.echo("Error {}-{}, code {} real code {}".format(start_date, end_date, code, real_code))
                click.echo("Query: {}".format({"code": real_code, "time": {"$gte": "{} 000000".format(start_date), "$lte": "{} 240000".format(end_date)}}))
            else:
                TICK5Main_COL.insert_many(ticks_5m)
    
def fitler_past_trade_info(files, out_path):
    # files = get_files_from_directory("D:/Others/data")
    # click.echo(files)
    keys = ["trigger", "triggerFactors", "cutFactors", "contractType", "contractCode", "direction", "triggerDate", "openDate", "closeDate", "openPrice", "closePrice", "closeType", "winCutPrice", "lossCutPrice", "resultPer", "resultRealPer", "openTime", "closeTime", "isWin", "realWin", "holdDays", "holdingZgj", "holdingZdj"]
    
    with open(out_path, "w", encoding="utf-8") as fw:
        fw.write("trigger,cut,type,date,resultPer\n")
        for file in files:
            with open(file, "r") as f:
                for line in f.readlines()[1:]:
                    data_arr = line.split(",")
                    fw.write("{},{},{},{},{}\n".format(data_arr[1], data_arr[2], data_arr[3], data_arr[7], data_arr[15]))

def split_data_by_filters(source_path,target_path, filter_str):
    with open(target_path, "w") as f0:
        with open(source_path, "r") as f1:
            for line in f1.readlines():
                if filter_str in line or 'date' in line:
                    f0.write(line)

if __name__ == "__main__":

    # files = get_files_from_directory("D:/Others/goodData")
    # merge results
    # merged_file = "./merge_data.csv"
    # fitler_past_trade_info(files, merged_file)


    # Split data
    split_data_by_filters("D:/Others/goodData/merge_data_2011-2020_reverse.csv", "D:/Others/goodData/merge_data_2011-2020_0_reverse.csv", "_0,")


    # tick_5m_to_main()
    # to_all_file()
    # import_to_db("E:/BaiduNetdiskDownload/all.csv")
    

# file_name = file.split("\\")[-1]
# contract_type = ""

# for c in file_name:
# if is_number(c):
#     break
# contract_type += c

# click.echo("{} {}".format(contract_type, file_name))
