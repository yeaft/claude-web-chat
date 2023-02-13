import numpy as np
from scipy.signal import find_peaks

def calculate_height(data, factor):
    return np.mean(data) + factor * np.std(data)

def calculate_prominence(data, factor):
    return -np.mean(data) + factor * np.std(data)

data = np.array([0.001, 0.003, 0.005, 0.008, 0.009, 0.01, 0.009, 0.008, 0.005, 0.003, 0.001])
factor = 1
peaks, _ = find_peaks(data, height=calculate_height(data, factor))
print(peaks)

data = np.array([0.001, 0.003, 0.005, 0.008, 0.009, 0.01, 0.009, 0.008, 0.005, 0.003, 0.001])
factor = 1
_, valleys = find_peaks(-data, prominence=calculate_prominence(data, factor), distance=1)
print(valleys)