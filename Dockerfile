FROM python:3.9-slim

# Update package lists and install tzdata
RUN apt-get update && apt-get install -y tzdata && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apt-get clean

# Set the working directory
WORKDIR /

# Add and install Python dependencies
ADD ./requirements.txt /
RUN pip install -r /requirements.txt

# Add the rest of the application files
ADD . /

# Install editable dependencies (if needed)
RUN pip install -e .

# Command to run the Python script
CMD [ "python", "/collection/realtime_tick.py" ]
