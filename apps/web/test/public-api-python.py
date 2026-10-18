"""复核：pip install openai；设置 OPENAI_BASE_URL、OPENAI_API_KEY、OPENAI_MODEL 后运行。"""
import os
from openai import OpenAI

client = OpenAI(base_url=os.environ['OPENAI_BASE_URL'], api_key=os.environ['OPENAI_API_KEY'], max_retries=0)
model = os.environ['OPENAI_MODEL']
messages = [{'role': 'system', 'content': 'Be helpful'}, {'role': 'user', 'content': 'Hi'}]
completion = client.chat.completions.create(model=model, messages=messages)
assert completion.object == 'chat.completion'
assert completion.choices[0].message.content
assert completion.usage.prompt_tokens > 0
stream = client.chat.completions.create(model=model, messages=messages, stream=True, stream_options={'include_usage': True})
text, usage, finished = '', None, False
for chunk in stream:
    if chunk.choices:
        text += chunk.choices[0].delta.content or ''
        finished = finished or chunk.choices[0].finish_reason in ('stop', 'length')
    if chunk.usage:
        usage = chunk.usage
assert text and finished and usage
assert usage.total_tokens == usage.prompt_tokens + usage.completion_tokens
print('Python OpenAI SDK: JSON 与 SSE 通过')
