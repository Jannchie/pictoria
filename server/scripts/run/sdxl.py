# %%
import torch
from diffusers import DPMSolverMultistepScheduler
from diffusers.pipelines import StableDiffusionXLPipeline
from diffusers.schedulers import AysSchedules
from diffusion_prompt_embedder import get_embeddings_sd15

sampling_schedule = AysSchedules["StableDiffusionXLTimesteps"]

model_path = "John6666/white-unicorn-v3-sdxl"

pipe = StableDiffusionXLPipeline.from_pretrained(
    model_path,
    torch_dtype=torch.bfloat16,
).to("cuda" if torch.cuda.is_available() else "cpu")
pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, algorithm_type="sde-dpmsolver++")


prompt = "score_9, 1girl, solo, oriental gothic, far east cloth, kimono, skirt, thighhighs, two side up, medium long hair, long sleeves, longhair, half closed eyes, long lower eyelashes, dynamic pose, running, dance, medium breast, inner thighs, looking at viewer, looking up, smile, head tilt, simple background, white background, close up, close range, from side, profile"  # noqa: E501

# %%
get_embeddings_sd15(
    pipe.tokenizer,
    pipe.text_encoder,
    prompt=prompt,
)
pipe(
    prompt=prompt,
    negative_prompt="nsfw, lowres, bad anatomy, error, blurry, score_4, score_5, score_6",
    height=1024,
    width=1024,
    num_inference_steps=30,
    # timesteps=sampling_schedule,
).images[0].save("test.png")
