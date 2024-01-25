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

    # 排除NaN值和data2_diff中的零值
    valid_indices = ~np.isnan(data1_diff) & ~np.isnan(data2_diff) & (data2_diff != 0)
    valid_data1_diff = data1_diff[valid_indices]
    valid_data2_diff = data2_diff[valid_indices]

    # 计算有效差异率并返回平均值
    return valid_data1_diff / valid_data2_diff

def predict_data1_by_data2(data1, data2, data2_value, cp_rate):
    data1_mean = np.mean(data1)
    data1_std = np.std(data1)
    data2_mean = np.mean(data2)
    data2_std = np.std(data2)
    
    # 将data2_value转换为Z分数，并使用cp_rate估算data1的Z分数
    data2_z = (data2_value - data2_mean) / data2_std    
    data1_z = data2_z * cp_rate
    # 将估算的Z分数转换回原始尺度并四舍五入为最近的整数
    return int(round(data1_z * data1_std + data1_mean))

def predict_data2_by_data1(data1, data2, data1_value, cp_rate):
    data1_mean = np.mean(data1)
    data1_std = np.std(data1)
    data2_mean = np.mean(data2)
    data2_std = np.std(data2)
    
    # 将data1_value转换为Z分数，并使用cp_rate估算data2的Z分数
    data1_z = (data1_value - data1_mean) / data1_std
    data2_z = data1_z / cp_rate
    # 将估算的Z分数转换回原始尺度并四舍五入为最近的整数
    return int(round(data2_z * data2_std + data2_mean))
