import numpy as np

# 函数：计算Z-score
def calculate_z_score(data):
    mean = np.mean(data)
    std = np.std(data)
    return [(x - mean) / std for x in data]

def calculate_diff_rate(data1, data2):
    data1_z = calculate_z_score(data1)
    data2_z = calculate_z_score(data2)
    data1_diff = np.diff(data1_z)
    data2_diff = np.diff(data2_z)
    return data1_diff / data2_diff