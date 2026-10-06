import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface WbPerson {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
}

/** Everyone the caller can see, by id (sticky authors, card assignees, comment authors, @mentions). */
export function useWbPeople() {
  return useQuery({
    queryKey: ["wb-people"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profile").select("id, username, display_name, avatar_url, is_active").order("display_name");
      if (error) throw error;
      const list = (data ?? []) as WbPerson[];
      return { list, byId: new Map(list.map((p) => [p.id, p])) };
    },
    staleTime: 5 * 60_000,
  });
}
