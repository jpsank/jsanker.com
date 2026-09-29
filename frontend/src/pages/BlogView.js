import React, { useState, useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Container } from "react-bootstrap";
import { db } from "../services/firebase";
import { deleteDoc, doc, onSnapshot } from "firebase/firestore";
import { ReactMarkdown } from "react-markdown/lib/react-markdown";
import { compareDates } from "../utils/helper";
import Skeleton from "react-loading-skeleton";
import { useAuth } from "../contexts/AuthContext";

const BlogView = () => {
    const navigate = useNavigate();
    const params = useParams();
    const [blog, setBlog] = useState(null);
    const { currentUser } = useAuth();
    const deleting = useRef(false);

    useEffect(() => {
        const unsubscribe = onSnapshot(doc(db, "blogs", params.id), (doc) => {
            if (!doc.exists()) {
                // the post vanishing because we just deleted it is not a 404
                if (!deleting.current) navigate("/404");
                return;
            }
            setBlog(doc.data({ serverTimestamps: "estimate" }));
        });
        return () => unsubscribe();
    }, [params.id, navigate]);

    const handleDelete = async () => {
        if (!window.confirm("Delete this post? This can't be undone.")) return;
        deleting.current = true;
        try {
            await deleteDoc(doc(db, "blogs", params.id));
            navigate("/blogs");
        } catch (error) {
            deleting.current = false;
            console.error("Failed to delete post:", error);
            window.alert("Couldn't delete the post. Please try again.");
        }
    };

    return (
        <Container className="my-5 mx-sm-5 mx-0">
            { blog === null ? <Skeleton count={15} containerClassName="mt-5" /> : (
                <>
                    <p>
                        {blog.dateCreated.toDate().toLocaleDateString()} {compareDates(blog.dateCreated, blog.dateUpdated) ? "(updated " + blog.dateUpdated.toDate().toLocaleDateString() + ")" : ""}
                        by <Link to={`/blogs/by/${blog.authorId}`}>{blog.authorName}</Link>
                    </p>
                    <ReactMarkdown>{blog.content}</ReactMarkdown>
                    { currentUser && currentUser.uid === blog.authorId && 
                        <div className="d-flex gap-3 align-items-center">
                            <Link to={`/blogs/${params.id}/edit`}>Edit</Link>
                            <Button variant="link" className="p-0 text-danger" onClick={handleDelete}>Delete</Button>
                        </div>
                    }
                </>
            )}
        </Container>
    );
}

export default BlogView;
