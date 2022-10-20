#!/usr/bin/python

import click
import os
import pathlib
import glob
import utils
from . import utils
from rarfile import RarFile

def unzip_file(file_name, password):
    with RarFile('test2.rar', 'r') as myrar:
        if password != None:
            myrar.extractall(pwd=password)
        else:
            myrar.extractall()

def get_files_from_directory(path):
    if ":/" not in path:
        if path[0] != "/":
            if path[0:2] == "./":
                path = str(pathlib.Path(__file__).parent.absolute()
                           ) + "/" + path[2:]
            else:
                path = str(pathlib.Path(
                    __file__).parent.absolute()) + "/" + path

    if os.path.isfile(path):
        return [path]

    if path[-1] != "/":
        path += "/"
    files = [f for f in glob.glob(path + "**/*.csv", recursive=True)]
    if len(files) == 0:
        files.append(path)

    return files


def list_all_file_names(dir_path, recursive=False):
    f = []
    for (dirpath, dirnames, filenames) in os.walk(dir_path):
        f.extend(filenames)
        if not recursive:
            break
    return f


def read_data(path):
    datas = []
    count = 0
    with open(path, "r") as f:
        first_line = f.readline()
        keys = first_line.rstrip('\n').rstrip('\r').split(",")
        for last_line in f:
            data_arr = last_line.rstrip('\n').rstrip('\r').split(",")
            data = {}
            for i in range(0, len(keys)):
                if keys[i] == "resultPer":
                    data[keys[i]] = round(float(data_arr[i]), 4)
                else:
                    data[keys[i]] = data_arr[i]
            # if data['date'] >= "20150101":
            datas.append(data)
            # count += 1
            # if count > 100000:
            #     break
    return datas


def read_data_with_num(path):
    datas = []
    loss_count = 0
    with open(path, "r") as f:
        first_line = f.readline()
        keys = first_line.rstrip('\n').rstrip('\r').split(",")
        for last_line in f:
            data_arr = last_line.rstrip('\n').rstrip('\r').split(",")
            data = {}
            if len(data_arr) != len(keys):
                loss_count += 1
                continue
            for i in range(0, len(keys)):
                if len(data_arr[i]) != 8 and data_arr[i][:2] != "20" and utils.is_number(data_arr[i]):
                    data[keys[i]] = float(data_arr[i])
                else:
                    data[keys[i]] = data_arr[i]
            datas.append(data)

    if loss_count > 0:
        click.echo("Loss data {}".format(loss_count))
    return datas


