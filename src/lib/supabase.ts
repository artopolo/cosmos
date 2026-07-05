import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'https://dtwnowpclxnzlrkmwbri.supabase.co';
const key =
  import.meta.env.VITE_SUPABASE_KEY ?? 'sb_publishable_qWrsm4Z43R9JuTRsjJp8gw_qYdDzUZt';

export const supabase = createClient(url, key);

export const IMAGE_BUCKET = 'cosmos-images';

export function imageUrl(path: string): string {
  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}
