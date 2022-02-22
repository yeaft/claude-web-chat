FROM python:3.9.7-alpine
WORKDIR /collection
ADD ./requirements.txt /collection/requirements.txt
RUN pip install -r requirements.txt
ADD . /collection
CMD [ "python", "./collection/real_time_tick.py" ]
