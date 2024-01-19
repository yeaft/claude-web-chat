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

    # Exclude NaN values from both data1_diff and data2_diff
    not_nan_indices = ~np.isnan(data1_diff) & ~np.isnan(data2_diff)

    # Further exclude zeros in data2_diff
    valid_indices = not_nan_indices & (data2_diff != 0)
    valid_data1_diff = data1_diff[valid_indices]
    valid_data2_diff = data2_diff[valid_indices]

    # Perform division where valid
    return valid_data1_diff / valid_data2_diff

    return data1_diff / data2_diff