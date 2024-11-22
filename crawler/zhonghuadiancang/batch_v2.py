import os
import re
import sys
import yaml
import glob
import argparse
import datetime
import json
import pymongo  # 用于连接 MongoDB 数据库
import openai   # 用于调用 DeepSeek API

# 定义全局变量
CONFIG_FILE = 'config.yaml'
CHAPTER_SEPARATOR = '=================================================='
DEFAULT_INPUT_PATTERN = './道教/庄子-庄子-(先秦,道教,哲学).txt'  # 默认的书籍文件匹配模式
PROMPT_FOLDER = './prompt'           # 存放生成的 prompt 文件的文件夹（可选）

def log(message):
    """
    打印日志信息，包含年月日时分秒。
    """
    current_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'[{current_time}] {message}')

def load_config(config_file):
    """
    从配置文件加载配置信息，包括数据库和 DeepSeek API 配置。
    """
    if not os.path.exists(config_file):
        log(f"配置文件 {config_file} 不存在，请创建配置文件并设置配置信息。")
        sys.exit(1)
    with open(config_file, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)
    return config

def get_book_files(input_pattern):
    """
    获取符合指定模式的书籍文件列表。
    """
    file_list = glob.glob(input_pattern, recursive=True)
    return file_list

def confirm_books(file_list):
    """
    输出要处理的书籍列表，供用户确认。
    """
    log("即将处理以下书籍：")
    for idx, file_path in enumerate(file_list, 1):
        log(f"{idx}. {file_path}")
    confirmation = input("确认开始处理吗？(y/n): ")
    return confirmation.lower() == 'y'

def load_books(file_list):
    """
    从文件列表中加载书籍内容，返回书籍信息的列表。
    """
    books = []
    for file_path in file_list:
        if not os.path.exists(file_path):
            log(f"文件 {file_path} 不存在，跳过。")
            continue
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        # 提取书名、作者、类别和标签（假设文件名格式为 'category/bookname-author-(tags).txt'）
        match = re.match(r'(.+)/(.+?)-(.+?)(?:-\((.*?)\))?\.txt$', file_path)
        if match:
            category = os.path.basename(match.group(1))
            book_name = match.group(2)
            author = match.group(3)
            tags = match.group(4).split(',') if match.group(4) else []
        else:
            category = 'Unknown'
            book_name = os.path.splitext(os.path.basename(file_path))[0]
            author = 'Unknown'
            tags = []
        books.append({
            'category': category,
            'book_name': book_name,
            'author': author,
            'tags': tags,
            'content': content,
        })
    return books

def split_into_chapters(content):
    """
    使用分隔符将书籍内容分割成章节，返回章节列表。
    """
    chapters = content.split(CHAPTER_SEPARATOR)
    return [chapter.strip() for chapter in chapters if chapter.strip()]

def construct_prompt(chapter_content):
    """
    构建发送给 LLM 的提示词。
    """
    prompt = f"""请对以下文言文进行分析：

{chapter_content}

要求：
1. 将以上内容翻译成白话文，不需要原文和译文对应。并以“白话文翻译”作为标题。
2. 翻译过程中对生僻字后面加上拼音和语调，对难理解的词后面加上简单解释。
3. 对整个段落以你国学大师的身份进行解读，并以“内容解读”作为标题。
3. 如果内容中包含典故，请进行解释说明，并以“典故解释”作为标题。
4. 汇总其中深刻有意义的句子，并以“深刻句子汇总”作为标题。
5. 给出章节的总结思想，字数为译文的十分之一，并以“章节总结”作为标题。

请按照以上要求生成内容，每个部分以对应的标题开头，内容之间用空行分隔，译文以及一些解释不需要加粗，以MD格式返回。
"""
    return prompt

def generate_and_load(books, deepseek_config, mongo_config, save_prompt=False):
    """
    为每本书的每个章节生成提示，调用 DeepSeek API 获取响应，解析响应内容，并保存到 MongoDB。
    """
    # 设置 OpenAI 客户端配置
    openai.api_key = deepseek_config.get('api_key')
    openai.base_url = deepseek_config.get('base_url')

    client = pymongo.MongoClient(mongo_config['host'], mongo_config['port'])
    db = client[mongo_config['database']]
    collection = db[mongo_config['collection']]

    for book in books:
        category = book['category']
        book_name = book['book_name']
        author = book['author']
        tags = book['tags']
        content = book['content']
        log(f"开始处理《{book_name}》 作者：{author}")

        chapters = split_into_chapters(content)

        for idx, chapter in enumerate(chapters):
            chapter_number = idx + 1
            chapter_title = f"第{chapter_number}章"
            log(f"处理 {chapter_title} ...")

            # 构建 prompt
            prompt = construct_prompt(chapter)

            # 如果需要保存 prompt，则写入文件
            if save_prompt:
                prompt_dir = os.path.join(PROMPT_FOLDER, book_name)
                os.makedirs(prompt_dir, exist_ok=True)
                prompt_file = os.path.join(prompt_dir, f"第{chapter_number}章.txt")
                with open(prompt_file, 'w', encoding='utf-8') as f:
                    f.write(prompt)
                log(f"已保存提示文件：{prompt_file}")

            try:
                # 调用 DeepSeek API 生成响应
                response = openai.chat.completions.create(
                    model="deepseek-chat",
                    messages=[
                        {"role": "system", "content": "你是中国国学大师，精通儒释道和中医理论"},
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.8,
                    max_tokens=4096,
                    stream=False
                )
                response_content = response.choices[0].message.content
                log(f"成功调用 DeepSeek API 获取响应。")
            except Exception as e:
                log(f"调用 DeepSeek API 生成响应时出错：{e}")
                continue

            # 解析响应内容
            parsed_content = parse_content(response_content)

            # 检查解析结果是否有效
            pc = parsed_content.get('plain_translation', '')
            if len(pc) < 10:
                log(f"章节 {chapter_title} 的白话文翻译内容过短，可能解析有误。")
                log(f"原文：{chapter}")
                log(f"解析内容：{response_content}")
                log("=========================================")

            # 组装章节信息
            chapter_info = {
                'name': book_name,
                'author': author,
                'categories': [category],
                'tags': tags,
                'chapter_count': len(chapters),
                'chapter': chapter_number,
                'chapter_title': chapter_title,
                'original_text': chapters[idx],
                'plain_translation': parsed_content.get('plain_translation', ''),
                'allusion_explanation': parsed_content.get('allusion_explanation', ''),
                'profound_sentences': parsed_content.get('profound_sentences', ''),
                'summary': parsed_content.get('summary', ''),
            }

            # 将章节信息插入到 MongoDB 中
            try:
                collection.replace_one(
                    {'name': book_name, 'author': author, 'chapter': chapter_number},
                    chapter_info,
                    upsert=True
                )
                log(f"已将《{book_name}》第 {chapter_number} 章保存到数据库。")
            except Exception as e:
                log(f"保存章节 {chapter_title} 到 MongoDB 时出错：{e}")

def parse_content(content_text):
    """
    解析响应的内容，提取五个部分：
    - 白话文翻译：plain_translation
    - 内容解读：content_explanation
    - 典故解释：allusion_explanation
    - 深刻句子汇总：profound_sentences
    - 章节总结：summary
    """
    sections = {
        'plain_translation': '',
        'content_explanation': '',
        'allusion_explanation': '',
        'profound_sentences': '',
        'summary': ''
    }

    # 定义标题的可能变体
    title_variants = {
        'plain_translation': ['白话文翻译', '翻译成白话文', '白话翻译', '白话译文', '翻译'],
        'content_explanation': ['内容解读'],
        'allusion_explanation': ['典故解释', '典故的解释', '典故注释'],
        'profound_sentences': ['深刻句子汇总', '深刻的句子汇总', '深刻句子', '经典句子'],
        'summary': ['章节总结', '本章总结', '章节的总结', '总结']
    }

    # 找到每个标题在文本中的位置
    content_text = content_text.strip()
    positions = []

    for section_key, variants in title_variants.items():
        for variant in variants:
            pos = content_text.find(variant)
            if pos != -1:
                positions.append((pos, variant, section_key))
                break  # 找到第一个匹配的标题后，退出当前循环

    # 如果没有找到任何一个标题，返回空的 sections
    if not positions:
        return sections

    # 根据标题的位置，按顺序提取内容
    positions.sort(key=lambda x: x[0])  # 按位置排序

    for i, (start_pos, title, section_key) in enumerate(positions):
        end_pos = len(content_text)
        if i + 1 < len(positions):
            end_pos = positions[i + 1][0]

        # 提取标题对应的内容，并去除标题行
        section_content = content_text[start_pos:end_pos].strip()
        # 去除标题行
        section_content = section_content[len(title):].strip()
        # 移除可能存在的章节标题，例如 '**第 3 章 养生主第三**'
        section_content = re.sub(r'^\*\*.*?\*\*', '', section_content, flags=re.MULTILINE).strip()
        # 替换 '###' 为空格
        section_content = section_content.replace('###', '').strip()

        # 将内容存入对应的字段
        sections[section_key] = section_content

    return sections

def main():
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='生成提示文件并调用 DeepSeek API 生成响应，或仅加载处理结果到 MongoDB。')
    parser.add_argument('--input', type=str, default=DEFAULT_INPUT_PATTERN, help='书籍文件的输入模式，支持 glob 模式。')
    parser.add_argument('--save_prompt', action='store_true', help='是否保存生成的提示文件。')
    args = parser.parse_args()

    # 加载配置
    config = load_config(CONFIG_FILE)

    # 获取书籍文件列表
    file_list = get_book_files(args.input)
    if not file_list:
        log("未找到任何符合条件的书籍文件。")
        sys.exit(1)

    # 确认要处理的书籍
    if not confirm_books(file_list):
        log("已取消处理。")
        sys.exit(0)

    # 加载书籍
    books = load_books(file_list)

    # 获取 DeepSeek API 配置
    deepseek_config = config.get('deepseek', {})
    if not deepseek_config.get('api_key') or not deepseek_config.get('base_url'):
        log("DeepSeek API 配置信息不完整，请在 config.yaml 中设置 'deepseek.api_key' 和 'deepseek.base_url'。")
        sys.exit(1)
    
    mongo_config = config.get('mongodb', {})
    if not mongo_config.get('host') or not mongo_config.get('database') or not mongo_config.get('collection'):
        log("MongoDB 配置信息不完整，请在 config.yaml 中设置 'mongodb.host', 'mongodb.database' 和 'mongodb.collection'。")
        sys.exit(1)

    # 生成提示文件、调用 DeepSeek API 并保存到 MongoDB
    generate_and_load(books, deepseek_config, mongo_config, save_prompt=args.save_prompt)

if __name__ == '__main__':
    main()
