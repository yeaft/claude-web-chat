FROM python:3.7.1-alpine
WORKDIR /app
ADD ./requirements.txt /app/requirements.txt
RUN pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
ADD . /app
CMD [ "python", "./futurestimulate/run.py" ]
