#!/usr/bin/python3
import click
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils

def retreive_data(path):
    main_paths, second_paths = get_paths(path)
    save_data_2_disk(main_paths, "main")
    save_data_2_disk(second_paths, "second")    

def save_data_2_disk(paths, contract_type):
    headers = ["market","code","time","zxj","ccl","zjl","cje","cjl"]
    datas = []    
    for p in paths:
        with open(p, "r") as f:
            for line in f.readlines()[1:]:
                data_str = line.replace("\r", "").replace("\n", "")
                data_arr = data_str.split(",")
                data = {}
                for i in range(len(headers)):
                    data[headers[i]] = data_arr[i]
                
                datas.append(data)
    
    click.echo("Finish collect {} data, insert to database now.".format(contract_type))
    if contract_type == "main":
        constance.TICK_COL.insert_many(datas)
    else:
        constance.TICK_SECOND_COL.insert_many(datas)

    # utils.convert_dic_to_csv(contract_type, datas)

def get_paths(path):
    main_paths, second_paths = [], []
    paths = file_utils.get_files_from_directory(path)
    for p in paths:
        if constance.SECOND_NAME in p:
            second_paths.append(p)
        elif constance.MAIN_NAME in p:
            main_paths.append(p)
    return main_paths, second_paths 

if __name__ == "__main__":
    path = "/home/hyi/misc/data/"
    retreive_data(path)