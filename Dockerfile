FROM python:3.9.7-alpine
RUN apk update && apk add tzdata && echo "Asia/Shanghai" > /etc/localtime
WORKDIR /
ADD ./requirements.txt /
RUN pip install -r /requirements.txt
ADD . /
RUN pip install -e .
CMD [ "python", "/collection/realtime_tick.py" ]
